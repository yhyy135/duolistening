import { test } from "node:test";
import assert from "node:assert/strict";
import { languageName } from "./i18n.ts";
import { LANGUAGES, LANGUAGE_NAMES } from "./model.ts";

test("a language is named in the language of the interface asking", () => {
  assert.equal(languageName("ja", "zh-CN"), "日语");
  assert.equal(languageName("ja", "fr"), "japonais");
  assert.equal(languageName("de", "ko"), "독일어");
  assert.equal(languageName("ja", "en"), "Japanese");
});

test("the two Chinese codes are named by script, never by country", () => {
  // `Intl.DisplayNames.of("zh-CN")` answers "Chinese (China)" and "zh-TW" answers
  // "Chinese (Taiwan)", which name countries where this setting means Simplified
  // against Traditional. The script subtags are what make these read correctly.
  assert.equal(languageName("zh-CN", "en"), "Simplified Chinese");
  assert.equal(languageName("zh-TW", "en"), "Traditional Chinese");
  assert.equal(languageName("zh-CN", "zh-CN"), "简体中文");
  assert.equal(languageName("zh-TW", "zh-TW"), "繁體中文");
  // The precise regression this guards is somebody dropping the script mapping, so it
  // is checked against exactly what would come back without it. Note that a bare "no
  // parentheses" rule would be wrong: Korean writes the script as 중국어(간체) and
  // German as "Chinesisch (vereinfacht)", both of which are the correct answer.
  for (const locale of LANGUAGES) {
    for (const code of ["zh-CN", "zh-TW"] as const) {
      const byRegion = new Intl.DisplayNames([locale], { type: "language" }).of(code);
      assert.notEqual(languageName(code, locale), byRegion, `${code} in ${locale}`);
    }
  }
});

test("the English answers still match the table the Text Model is given", () => {
  // Not a coincidence worth losing: the prompt and the English interface should not
  // disagree about what a language is called.
  for (const code of LANGUAGES) {
    assert.equal(languageName(code, "en"), LANGUAGE_NAMES[code], code);
  }
});

test("every language names every language as something, in every interface", () => {
  for (const locale of LANGUAGES) {
    for (const code of LANGUAGES) {
      const named = languageName(code, locale);
      assert.ok(named.length > 0, `${code} in ${locale}`);
      // Never the raw subtag — that is the "no data" answer, and it would reach a
      // button as the literal text "zh-Hant".
      assert.doesNotMatch(named, /^[a-z]{2}(-[A-Za-z]+)?$/, `${code} in ${locale}`);
    }
  }
});
