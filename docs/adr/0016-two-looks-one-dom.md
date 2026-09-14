# Two looks, one DOM

Status: accepted.

The app has two looks, and the reader picks one in Settings.

- **Standard** is the default. It is the category's own convention, a music app's lyric page, held to the bar of NetEase Cloud Music and QQ Music.
- **Station** reads the Transcript as a railway timetable.

Both render the same components and the same markup. The look is the `data-look` attribute on the root element, absent for Standard, and the stylesheet is the only thing that differs:

- each look's palette is written once, under its own prefix
- the names every rule uses are aliases, pointed at one palette or the other
- Station's structural rules sit in one block under `[data-look="station"]`: the route and its stops, the status strip, and the ticks along the band

The alternative was a component tree per look, rejected because of what the player is. The lyrics view carries a dozen invariants about the audio element, the frame loop, the translation window and the writers to the Transcript, and every one of them was a real bug once; two trees would be two places to keep each of them true. So the markup carries the union of what either look draws — every Line's start time, the stops either side of the current one, a tick per Line — and a look with no use for a piece hides it.

The cost is a few elements that one look or the other never shows, and a class name is now a promise to both. A section of the player called `.now` matched the sweep state of the same name, and hid the Token being spoken on every phone.

The choice belongs to the device, not the reader, so it lives in localStorage beside the theme rather than in Settings:

- it must be in force before the first paint, which IndexedDB cannot promise
- it applies the moment it is picked, which a Save button would contradict

The same move took the light/dark cycle out of the header, where it sat alone, and put both in one Appearance section. Neither travels in the settings transfer string: on a second device either look is one tap away.

The looks do not share a typeface either, since Station in the platform sans read as a reskin. Station sets its Latin letters and numerals in Barlow, a grotesk drawn from California's highway signs and transit. It is licensed under SIL OFL 1.1 and self-hosted: three weights, about 67 KB in all, in `src/web/fonts/` with the licence beside them. Only a Station page downloads it, and `unicode-range` holds it to Latin, so every CJK character still falls through to the system face its Line's language selects.

A CJK face was weighed and refused. Source Han Sans (Noto Sans CJK) is several megabytes per weight and per region. Naming a single region would set Japanese kanji in Chinese forms, which is the fault the font stack's silence about CJK exists to prevent. It is also what Android already draws.
