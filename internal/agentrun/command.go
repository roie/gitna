package agentrun

import (
	"crypto/rand"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"unicode"
)

func SplitCommand(line string) ([]string, error) {
	var words []string
	var word strings.Builder
	var quote rune
	started := false
	for _, r := range line {
		switch {
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				word.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
			started = true
		case unicode.IsSpace(r):
			if started {
				words = append(words, word.String())
				word.Reset()
				started = false
			}
		default:
			word.WriteRune(r)
			started = true
		}
	}
	if quote != 0 {
		return nil, errors.New("unclosed quote in command")
	}
	if started {
		words = append(words, word.String())
	}
	if len(words) == 0 {
		return nil, errors.New("enter an agent command")
	}
	return words, nil
}

func Resolve(name, line string) (Definition, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 128 {
		return Definition{}, errors.New("an agent name must be between 1 and 128 bytes")
	}
	words, err := SplitCommand(line)
	if err != nil {
		return Definition{}, err
	}
	path, err := exec.LookPath(words[0])
	if err != nil {
		return Definition{}, err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return Definition{}, err
	}
	return Definition{ID: rand.Text(), Name: name, Executable: path, Args: words[1:]}, nil
}
