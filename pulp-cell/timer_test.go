package main

import "testing"

// newTestTimer builds a Timer directly (no Hub/SSE) for pure-logic tests.
func newTestTimer() *Timer {
	return &Timer{
		Mode:           modeWork,
		WorkSecs:       25 * 60,
		BreakSecs:      5 * 60,
		LongBreakSecs:  15 * 60,
		LongBreakEvery: 4,
		Remaining:      25 * 60,
	}
}

// A normal cycle: every 4th work phase yields a long break, which then resets
// the round counter back to a fresh work phase.
func TestCadenceLongBreakEvery4(t *testing.T) {
	tm := newTestTimer()
	now := int64(1000)
	tm.start(now)

	want := []struct {
		mode  string
		round int
	}{
		{modeBreak, 1},     // after work #1
		{modeWork, 1},      // back to work
		{modeBreak, 2},     // after work #2
		{modeWork, 2},      // back to work
		{modeBreak, 3},     // after work #3
		{modeWork, 3},      // back to work
		{modeLongBreak, 4}, // after work #4 -> long break
		{modeWork, 0},      // long break ends -> cycle resets
	}

	for i, w := range want {
		// Jump to exactly the current phase end so a single phase elapses.
		now = tm.EndsAt
		if !tm.advance(now) {
			t.Fatalf("step %d: expected advance to fire at EndsAt", i)
		}
		if tm.Mode != w.mode || tm.Round != w.round {
			t.Fatalf("step %d: got mode=%s round=%d, want mode=%s round=%d", i, tm.Mode, tm.Round, w.mode, w.round)
		}
		if !tm.Running {
			t.Fatalf("step %d: timer should still be running after a single-phase advance", i)
		}
	}
}

// The replay-bug guard: if the room was left running unattended for more than
// one phase, advance must NOT loop through every elapsed phase — it snaps to a
// clean, stopped state instead.
func TestAdvanceUnattendedSnapsClean(t *testing.T) {
	tm := newTestTimer()
	now := int64(1000)
	tm.start(now) // work, EndsAt = 1000 + 1500

	// Jump a full day ahead — dozens of phases would have elapsed.
	far := now + 24*60*60
	if !tm.advance(far) {
		t.Fatal("expected advance to report a change")
	}
	if tm.Running {
		t.Fatal("unattended multi-phase gap should leave the timer stopped, not running")
	}
	if tm.EndsAt != 0 {
		t.Fatalf("stopped timer must clear EndsAt, got %d", tm.EndsAt)
	}
	if tm.Remaining != tm.phaseSecs() {
		t.Fatalf("stopped timer remaining should equal the new phase length, got %d want %d", tm.Remaining, tm.phaseSecs())
	}
}

// advance is a no-op while paused or before the phase end.
func TestAdvanceNoopBeforeEnd(t *testing.T) {
	tm := newTestTimer()
	tm.start(1000)
	if tm.advance(1000 + 100) {
		t.Fatal("advance should not fire before EndsAt")
	}
	if tm.Mode != modeWork || tm.Round != 0 {
		t.Fatal("state should be untouched before the phase ends")
	}
	tm.stop(1000 + 100)
	if tm.advance(1000 + 99999) {
		t.Fatal("advance should not fire while paused")
	}
}

// LongBreakEvery == 0 disables long breaks entirely (plain work/break cycle).
func TestCadenceDisabled(t *testing.T) {
	tm := newTestTimer()
	tm.LongBreakEvery = 0
	now := int64(0)
	tm.start(now)
	for i := 0; i < 10; i++ {
		now = tm.EndsAt
		tm.advance(now)
		if tm.Mode == modeLongBreak {
			t.Fatalf("step %d: long break should never occur when disabled", i)
		}
	}
}

// stop freezes the remaining time; reset restores the full phase length.
func TestStopAndReset(t *testing.T) {
	tm := newTestTimer()
	tm.start(1000)
	tm.stop(1000 + 600) // 10 min into a 25 min work phase
	if tm.Running {
		t.Fatal("stop should pause")
	}
	if tm.Remaining != 25*60-600 {
		t.Fatalf("remaining after stop = %d, want %d", tm.Remaining, 25*60-600)
	}
	tm.reset()
	if tm.Remaining != 25*60 {
		t.Fatalf("remaining after reset = %d, want %d", tm.Remaining, 25*60)
	}
}
