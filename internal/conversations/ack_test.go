package conversations

import (
	"slices"
	"testing"
)

func TestAckIsPerMessage(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	a := joinAgent(t, s)
	var seqs []uint64
	for _, id := range []string{"first", "second", "third"} {
		c, err := s.Create(human, id, anchorAt("a", 1, 1, "x"), id, []string{a.ID})
		if err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, c.Messages[0].Seq)
	}
	if err := s.Ack(a.ID, []uint64{seqs[1], 999}); err != nil {
		t.Fatal(err)
	}
	pending, err := s.Pending(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []uint64
	for _, p := range pending {
		got = append(got, p.Message.Seq)
	}
	if !slices.Equal(got, []uint64{seqs[0], seqs[2]}) {
		t.Fatalf("pending = %v", got)
	}
}
