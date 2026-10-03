# How a person drives an app, and what simframe should copy

2026-10-03. The source is the owner, who knows the field app well: five
recorded runs of each job with `simframe baseline record` on the same simulator
the agents used, one screen recording of a service request, and their own
answers to five questions afterwards. The answers are quoted, lightly trimmed.

## The measurement

| job | runs (s) | median |
| --- | --- | --- |
| create a service request (7-step wizard) | 51.4, 40.8, 36.3, 32.4, 39.1 | **39.1 s** |
| add an asset and sync it | 56.5, 80.5, 38.6, 47.2, 48.9 | **48.9 s** |

Every agent setup took 13–16 minutes for both jobs: **9–10× slower** (BENCHMARKS,
"Who drives"). The gap is not perception or input. simframe reads a screen in
well under a second and taps in milliseconds. The gap is how often the agent
stops to think: the person made about 12 decisions for the service request, and
the agents made 50–130 model calls.

## Where a person's 38 seconds go

Scene changes in the screen recording, matched to frames:

| moment | time | whose time |
| --- | --- | --- |
| Home → CREATE A SERVICE REQUEST | 0 → 2.1 s | decision, 2 s |
| location list loading | 2.1 → 4.1 s | app |
| tap a location | 4.1 → 5.7 s | decision, 1.6 s |
| asset list loading | 5.7 → 10.8 s | app, 5 s |
| tap an asset, open Problem, pick one, APPLY | 10.8 → 16.0 s | about 1.3 s per choice |
| NEXT, NEXT past two information screens | 16 → 22.8 s | glance and go, part app |
| provider, minimal required text, REVIEW | 22.8 → 34.6 s | the longest stretch: picking and typing |
| SUBMIT → "Work Order #" | 34.6 → 36.1 s | done |

About a quarter is the app loading. The rest is roughly one or two seconds a
decision.

## The owner's own account

**What they look for on a known screen.** "I see the big button(s) under the
screen. If it's one, I suppose it's the next/save/agree/approve; if there are
more, I take a closer look and click on the one that sends me forward." Mostly
words, not places: "I don't properly remember or memorise the places … unless I
worked like 100 times with those screens."

**Choosing options.** "When choosing options I just chose something. I don't
really think on that unless it's specifically asked to select a specific option."

**Knowing a step worked.** "If I click on next/save/submit and I see myself on the
next screen then it worked; otherwise I look for validation errors or some other
error, maybe a backend error."

**When they stop and think.** "I only think when I get surprised. For example I
filled the form (as I know) but then the save doesn't work or a validation error
pops up; then I scroll and look for what's wrong."

**First time and second time.** "The first time I may look at the labels, but the
second time I may look at the places too."

**Typing.** "I type 'Mo' because my task is just finish CSR. It's not finish CSR
typing something specific. In that case I would take a few more milliseconds."

## What simframe should copy

1. **A forward control.** The map names the screen's primary action: the big
   button at the bottom. With one, that is forward. With several, it is the one
   whose words move on (next, save, submit, review, apply, approve), never a
   destructive or barrier control.
2. **Success is arriving.** A forward tap that changes the screen is `ok`, and
   nothing needs re-reading. Only a forward tap that stays put needs a look.
3. **Surprises are handled locally first.** When forward does not move, simframe
   scrolls the form and collects the validation messages itself ("not saved:
   Warranty Start Date is required"), and returns them in one line. The model is
   consulted with the answer, not asked to hunt for it.
4. **Satisfice.** A brief says what matters. Every other option gets the first
   valid choice and every other required text gets a minimal valid value, still
   never through the verify barrier.
5. **Words first, places later.** Labels stay the selector. The graph already
   stores positions; on screens seen many times they become a prior that
   shortens the search, the way a person's second run does.
6. **Habits.** A flow done once is saved with its choices as slots and replayed,
   checking only at the milestone. A repeat should cost app time plus taps,
   which is the person's 39 seconds.

The target this sets: a service request in about three model calls on a first
run (brief, one goal-or-batch to the end, milestone check), and a repeat run
near 39 seconds. Each change is measured against the medians above.
