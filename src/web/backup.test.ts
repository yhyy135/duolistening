import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource, Settings, Transcript } from "../shared/model.ts";
import {
  BACKUP_VERSION,
  audioMatches,
  backupFilename,
  buildBackup,
  parseBackup,
  planImport,
  type BackupEntry,
} from "./backup.ts";

const transcript: Transcript = [
  { text: "ごんぎつね", startSec: 0, endSec: 2.5 },
  { text: "新美南吉", startSec: 2.5, endSec: 4 },
];

function resource(over: Partial<Resource> = {}): Resource {
  return {
    id: "r1",
    source: { kind: "podcast", feedUrl: "https://f.example", episodeUrl: "https://e.example/1.mp3", title: "ep" },
    title: "ごん狐 01",
    durationSec: 315.86,
    nativeLanguage: "zh-CN",
    importedAt: "2026-09-06T17:30:56.553Z",
    phase: "ready",
    ...over,
  };
}

const entry = (over: Partial<Resource> = {}): BackupEntry => ({ resource: resource(over), transcript });

const settings: Settings = {
  textModel: { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_real_secret", model: "m" },
  transcriptionModel: { baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_also_secret", model: "w" },
  nativeLanguage: "zh-CN",
};

test("only finished Resources are exported, and the rest are named", () => {
  const { backup, excluded } = buildBackup({
    entries: [
      entry({ id: "done" }),
      entry({ id: "mid", phase: "transcribing" }),
      entry({ id: "broke", phase: "failed" }),
    ],
  });

  assert.deepEqual(backup.entries.map((e) => e.resource.id), ["done"]);
  assert.deepEqual(excluded.map((r) => r.id), ["mid", "broke"]);
});

test("keys are stripped by default and kept only when asked", () => {
  const without = buildBackup({ entries: [entry()], settings }).backup;
  assert.equal(without.settings?.textModel.apiKey, "");
  assert.equal(without.settings?.transcriptionModel.apiKey, "");
  // Everything else about the slot survives, so a restore only needs the key retyped.
  assert.equal(without.settings?.textModel.model, "m");
  assert.equal(without.settings?.nativeLanguage, "zh-CN");

  const with_ = buildBackup({ entries: [entry()], settings, includeKeys: true }).backup;
  assert.equal(with_.settings?.textModel.apiKey, "gsk_real_secret");
});

test("no settings asked for, none written", () => {
  const { backup } = buildBackup({ entries: [entry()] });
  assert.equal("settings" in backup, false);
});

test("a backup round-trips through JSON", () => {
  const { backup } = buildBackup({ entries: [entry()], exportedAt: "2026-09-08T01:00:00.000Z" });
  const parsed = parseBackup(JSON.stringify(backup));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.backup.entries, backup.entries);
  assert.deepEqual(parsed.ok && parsed.skipped, []);
});

test("a bad envelope refuses the whole file", () => {
  const cases: [string, string][] = [
    ["not json at all", "not JSON"],
    ["[1,2,3]", "not a backup"],
    [JSON.stringify({ format: "something-else", version: 1, entries: [] }), "not written by duolistening"],
    [JSON.stringify({ format: "duolistening-backup", entries: [] }), "no usable version"],
    [JSON.stringify({ format: "duolistening-backup", version: 1 }), "no entries"],
  ];
  for (const [text, expected] of cases) {
    const parsed = parseBackup(text);
    assert.equal(parsed.ok, false, `${text.slice(0, 30)} should be refused`);
    assert.match(!parsed.ok ? parsed.problem : "", new RegExp(expected, "i"));
  }
});

test("a backup from a newer build is refused rather than half-read", () => {
  const { backup } = buildBackup({ entries: [entry()] });
  const parsed = parseBackup(JSON.stringify({ ...backup, version: BACKUP_VERSION + 1 }));

  assert.equal(parsed.ok, false);
  assert.match(!parsed.ok ? parsed.problem : "", /Update first/);
});

test("one corrupt entry is dropped and named; the good ones still import", () => {
  const { backup } = buildBackup({ entries: [entry({ id: "good", title: "Keeps" })] });
  const parsed = parseBackup(
    JSON.stringify({
      ...backup,
      entries: [
        ...backup.entries,
        { resource: { ...resource({ id: "x" }), title: "No transcript" }, transcript: [] },
        { resource: { ...resource({ id: "y" }), title: "Bad lines" }, transcript: [{ text: "hi" }] },
        { resource: { id: "", title: "No id" }, transcript },
        "not even an object",
      ],
    }),
  );

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.backup.entries.map((e) => e.resource.id), ["good"]);
  assert.deepEqual(parsed.ok && parsed.skipped, ["No transcript", "Bad lines", "No id", "entry 5"]);
});

test("import adds what is missing and never touches what is here", () => {
  const { backup } = buildBackup({
    entries: [entry({ id: "have", title: "Already" }), entry({ id: "want", title: "New" })],
  });
  const plan = planImport(["have", "other"], backup);

  assert.deepEqual(plan.add.map((e) => e.resource.id), ["want"]);
  assert.deepEqual(plan.alreadyHere, [{ id: "have", title: "Already" }]);
});

test("a file listing the same id twice queues it once", () => {
  const { backup } = buildBackup({ entries: [entry({ id: "dup" }), entry({ id: "dup" })] });
  const plan = planImport([], backup);
  assert.equal(plan.add.length, 1);
});

test("settings are restored only on request", () => {
  const { backup } = buildBackup({ entries: [entry()], settings });
  assert.equal(planImport([], backup).settings, undefined);
  assert.equal(planImport([], backup, { restoreSettings: true })?.settings?.nativeLanguage, "zh-CN");
});

test("re-fetched audio has to line up with the Transcript it was made from", () => {
  assert.equal(audioMatches(1550.76, 1550.76), true);
  assert.equal(audioMatches(1550.76, 1551.2), true, "header vs decoder rounding is fine");
  // The real case: one host spliced 30s of advertising by User-Agent.
  assert.equal(audioMatches(1550.76, 1580.8), false);
});

test("the filename sorts by date", () => {
  assert.equal(backupFilename("2026-09-08T01:23:45.000Z"), "duolistening-backup-2026-09-08.json");
  assert.equal(backupFilename(""), "duolistening-backup-undated.json");
});
