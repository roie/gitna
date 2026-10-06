package app

import (
	"bufio"
	"context"
	"io"
	"os"
	"regexp"
	"unicode"
	"unicode/utf8"

	"github.com/roie/gitna/internal/protocol"
)

const contentSearchBufferedLineLimit = 64 << 10

func readContentSearchLine(ctx context.Context, reader *bufio.Reader) ([]byte, int64, int64, error) {
	var line []byte
	var size int64
	var previous, last byte
	for {
		if err := ctx.Err(); err != nil {
			return nil, 0, 0, err
		}
		chunk, err := reader.ReadSlice('\n')
		if len(chunk) > 0 {
			if len(chunk) > 1 {
				previous = chunk[len(chunk)-2]
			} else {
				previous = last
			}
			last = chunk[len(chunk)-1]
		}
		size += int64(len(chunk))
		if size <= contentSearchBufferedLineLimit {
			if err != bufio.ErrBufferFull && line == nil {
				line = chunk
			} else {
				line = append(line, chunk...)
			}
		} else {
			line = nil
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		length := size
		if last == '\n' && size > 0 {
			length--
			last = previous
		}
		if last == '\r' && length > 0 {
			length--
		}
		if line != nil {
			line = line[:int(length)]
		}
		return line, size, length, err
	}
}

type contentSearchRuneReader struct {
	ctx     context.Context
	reader  *bufio.Reader
	section io.SectionReader
	runes   uint
}

func newContentSearchRuneReader(ctx context.Context, file *os.File, start, length int64) *contentSearchRuneReader {
	r := &contentSearchRuneReader{ctx: ctx}
	r.section = *io.NewSectionReader(file, start, length)
	r.reader = bufio.NewReaderSize(&r.section, 32<<10)
	return r
}

func (r *contentSearchRuneReader) reset(file *os.File, start, length int64) {
	r.section = *io.NewSectionReader(file, start, length)
	r.reader.Reset(&r.section)
	r.runes = 0
}

func (r *contentSearchRuneReader) ReadRune() (rune, int, error) {
	if r.runes%1024 == 0 {
		if err := r.ctx.Err(); err != nil {
			return 0, 0, err
		}
	}
	r.runes++
	return r.reader.ReadRune()
}

func contentSearchAdjacentRune(file *os.File, start, length, position int64, before bool) (rune, int) {
	var data [utf8.UTFMax]byte
	if before {
		if position == 0 {
			return -1, 0
		}
		size := min(position, int64(len(data)))
		n, _ := file.ReadAt(data[:size], start+position-size)
		return utf8.DecodeLastRune(data[:n])
	}
	if position == length {
		return -1, 0
	}
	n, _ := file.ReadAt(data[:min(length-position, int64(len(data)))], start+position)
	return utf8.DecodeRune(data[:n])
}

func scanLongContentSearchLine(ctx context.Context, file *os.File, start, length int64, number, limit int, expression, continuation *regexp.Regexp, wholeWord bool) ([]protocol.ContentSearchMatch, bool, error) {
	validation := newContentSearchRuneReader(ctx, file, start, length)
	for {
		r, size, err := validation.ReadRune()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, false, err
		}
		if r == 0 || r == utf8.RuneError && size == 1 {
			return nil, false, nil
		}
	}
	counter := newContentSearchRuneReader(ctx, file, start, length)
	var counted int64
	units := 0
	advance := func(target int64) (int, error) {
		for counted < target {
			r, size, err := counter.ReadRune()
			if err != nil {
				return 0, err
			}
			counted += int64(size)
			units++
			if r > 0xffff {
				units++
			}
		}
		return units, nil
	}
	var matches []protocol.ContentSearchMatch
	var offset int64
	previousEnd := int64(-1)
	reader := newContentSearchRuneReader(ctx, file, start, length)
	for offset <= length && len(matches) < limit {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		sectionStart := offset
		if offset > 0 {
			_, size := contentSearchAdjacentRune(file, start, length, offset, true)
			sectionStart -= int64(size)
		}
		reader.reset(file, start+sectionStart, length-sectionStart)
		var indices []int
		if offset == 0 {
			indices = expression.FindReaderIndex(reader)
		} else if found := continuation.FindReaderSubmatchIndex(reader); found != nil {
			indices = found[2:4]
		}
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		if indices == nil {
			break
		}
		begin, end := sectionStart+int64(indices[0]), sectionStart+int64(indices[1])
		accepted := begin != end || begin != previousEnd
		if wholeWord {
			before, _ := contentSearchAdjacentRune(file, start, length, begin, true)
			after, _ := contentSearchAdjacentRune(file, start, length, end, false)
			word := func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }
			accepted = accepted && !word(before) && !word(after)
		}
		if accepted {
			column, err := advance(begin)
			if err != nil {
				return nil, false, err
			}
			endColumn, err := advance(end)
			if err != nil {
				return nil, false, err
			}
			match, err := longContentSearchExcerpt(file, start, length, begin, end, number, column, endColumn-column)
			if err != nil {
				return nil, false, err
			}
			matches = append(matches, match)
		}
		previousEnd = end
		offset = end
		if begin == end {
			if end == length {
				break
			}
			_, size := contentSearchAdjacentRune(file, start, length, end, false)
			offset += int64(size)
		}
	}
	return matches, true, ctx.Err()
}

func longContentSearchExcerpt(file *os.File, start, length, begin, end int64, number, column, matchLength int) (protocol.ContentSearchMatch, error) {
	windowStart := max(int64(0), begin-24-utf8.UTFMax)
	data := make([]byte, min(length-windowStart, int64(contentSearchExcerptLimit+2*utf8.UTFMax)))
	if _, err := file.ReadAt(data, start+windowStart); err != nil {
		return protocol.ContentSearchMatch{}, err
	}
	first := int(max(int64(0), begin-24) - windowStart)
	for first > 0 && !utf8.RuneStart(data[first]) {
		first--
	}
	last := min(len(data), first+contentSearchExcerptLimit)
	for last < len(data) && !utf8.RuneStart(data[last]) {
		last--
	}
	prefix, suffix := "", ""
	if windowStart+int64(first) > 0 {
		prefix = "…"
	}
	if windowStart+int64(last) < length {
		suffix = "…"
	}
	localBegin := int(begin - windowStart)
	localEnd := min(int(end-windowStart), last)
	return protocol.ContentSearchMatch{
		Line: number, Column: column, Length: matchLength,
		Excerpt:    prefix + string(data[first:last]) + suffix,
		MatchStart: utf16Length(prefix) + utf16Length(string(data[first:localBegin])),
		MatchEnd:   utf16Length(prefix) + utf16Length(string(data[first:localEnd])),
	}, nil
}
