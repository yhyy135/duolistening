---
version: 1
slug: "src-web-player-tsx"
primary_target: "src/web/player.tsx"
related_targets:
  ["src/web/library.tsx", "src/web/settings.tsx", "src/web/app.tsx", "src/web/styles.css"]
---

# Duolistening app surfaces: Library, Player, Settings

Scope: the whole reader-facing app, rendered in two selectable looks over one DOM. Visitor mode: Operate.

**Audience and job.** Language learners studying real podcasts, on a phone (one-handed, lock screen) and on a desktop (keyboard). The jobs:

- resume an episode
- move by Lines: replay, loop, previous and next
- switch between reading along, original only, and blind listening
- ask about a Line
- import an episode
- set up keys and the proxy

**Constraints.**

- The invariants in CLAUDE.md.
- Eight interface languages.
- Light, dark and auto.
- A 44px touch floor and 16px text fields on touch.
- Reduced motion is honoured.
- Colours come only from `light-dark()` tokens.

**Chosen.** Two looks, picked per device in Settings → Appearance. Standard is the default and Station is the alternative. Standard's bar is the lyric page of NetEase Cloud Music and QQ Music.

**Memorable moment.**

- Standard: the current Line fills word by word in the lyric column.
- Station: the train marker stands at the current stop on the route.

**Unresolved.** Only episodes imported after this change carry a real cover; the three local fixtures show monogram covers.

## Direction contract

### Standard (default)

THESIS: A music app's lyric page, applied to speech. The episode's cover sets the mood, only the current Line stands at full ink, and its words fill with the accent as they are spoken. It refuses the podcast-app habit of a player card stacked above a plain list.

OWN-WORLD:

- White ground, near-black in dark.
- One blue accent, reserved for play, the word fill, progress and selection.
- Lines other than the current one in a lighter grey.
- System sans. Lines bold at 26px on desktop and 21px on a phone, translations in regular weight beneath.
- Covers with 12px corners and a soft shadow; pill chips; round transport buttons.
- A blurred, heavily scrimmed wash of the cover behind the player.

STORY: The reader opens the shelf and sees what they were in the middle of first, then resumes it in one tap. In the player they follow, drill, blind-listen and check without leaving the lyric column. New shows come from a grid of covers under the shelf.

FIRST VIEWPORT: The player.

- Desktop: a 360px left column holding, from top to bottom:
  - the cover, title, show and language pair
  - a scrubber with elapsed time, "Line n of N" and remaining time
  - replay, previous, a 64px blue play button, next and loop
  - the subtitle-mode switch and the rate

  The lyric column fills the right.

- Phone: a slim top bar with back, cover and title; lyrics filling the screen; the same controls as a bottom dock within thumb reach.

FORM: The category standard, played straight. The user chose it in the round from seed f82615b6 (re-roll 1). Bar: NetEase Cloud Music / QQ Music lyric pages.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

### Station (optional)

THESIS: The Transcript is a timetable. Every Line is a stop on one route, the current Line is the station the train is standing at, and the previous and next Lines are the stops either side. It refuses the lyric-app wall of dimmed text.

OWN-WORLD:

- Ground: platform concrete, night-black in dark, under white sign panels.
- Route green carries the route line, the stop dots, the progress band and the play button.
- An amber LED strip carries status; red is reserved for failures.
- The show's cover, square-cornered, identifies an episode's show at a glance.
- Barlow (self-hosted, OFL) for Latin letters and numerals; CJK falls through to the system face each Line's language picks.
- Square corners, 4px route rules, tabular numerals.
- Lighting a Line changes its colour, never its size or position.

STORY: The reader reads their position the way a commuter reads a line diagram: how many stops have passed, and which stop is next. They move one stop at a time with the transport. The shelf reads as a departure board of episodes.

FIRST VIEWPORT: The player.

- Desktop, from top to bottom:
  - a white top bar with back, the episode's badge, title and show
  - a centred 860px timetable: a time column, then the route, with passed stops filled and the current stop ringed
  - a dock:
    - the LED status strip
    - the previous and next stop names at either end of a band ticked once per Line, with a ringed train marker
    - elapsed time, "Line n of N" and remaining time
    - subtitle modes on the left; replay, previous, play, next and loop in the centre; rate on the right
- Phone: the same stack, with the time column dropped and the controls on two rows.

FORM: The assigned direction from seed f82615b6, re-roll 1; my own grounded candidate 5. Raises kept:

- one alert colour, reserved for change
- lighting changes colour, never size
- no framed Lines
- a single active mark per screen, carried by a filled stop or badge, never by a side border
- the same label grid on every shelf row

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
