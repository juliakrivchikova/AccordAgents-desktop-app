import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_SEARCH_MAX_WORDS, MEMORY_SNIPPET_MAX_CHARS, candidateAnchors, rankByWords, sameWord, searchTextOf, searchWords, snippetOf
} from "./memoryWordSearch";

const note = (title: string, body: string, tags: string[] = []) => ({ title, tags, body, searchText: searchTextOf({ title, tags, body }) });
const titles = (notes: Array<ReturnType<typeof note>>, query: string, total = notes.length) =>
  rankByWords(notes, searchWords(query), { total, averageLength: 0 }).map((item) => item.note.title);

test("a word counts in its other forms, the same way for every language", () => {
  for (const [asked, held] of [
    ["test", "tests"], ["fix", "fixed"], ["user", "users"], ["log", "logs"], ["тест", "тесты"], ["ключ", "ключи"], ["файл", "файлы"],
    ["лог", "логах"], ["ветка", "ветку"], ["test", "testing"], ["deploy", "deployment"], ["заметка", "заметку"], ["ключи", "ключ"]
  ]) assert.ok(sameWord(asked, held), `${asked} ~ ${held}`);
  for (const [asked, held] of [["release", "relevant"], ["на", "нам"], ["to", "today"], ["test", "text"], ["deploy", "depot"]]) {
    assert.ok(!sameWord(asked, held), `${asked} !~ ${held}`);
  }
});

test("the words asked: lower case, no one-letter words, of two forms the shorter, at most a limit", () => {
  assert.deepEqual(searchWords("Деплой деплоя, Tests test и a QA").map((item) => item.word), ["деплой", "test", "qa"]);
  assert.deepEqual(searchWords("   "), []);
  assert.deepEqual(searchWords("a и ?"), []);
  assert.equal(searchWords(Array.from({ length: 50 }, (_, index) => `${index}qwerty`).join(" ")).length, MEMORY_SEARCH_MAX_WORDS);
  // Two-letter words pick candidates only when nothing longer is asked.
  assert.deepEqual(candidateAnchors(searchWords("on deploy")), ["dep"]);
  assert.deepEqual(candidateAnchors(searchWords("on to")), ["on", "to"]);
});

test("one short word finds its forms, as the old search did (review: test, тест, ключ found nothing)", () => {
  const notes = [note("Tests", "The tests run nightly."), note("Ключи", "Где лежат ключи и файлы."), note("Логи", "Смотреть в логах."), note("Other", "Nothing here.")];
  assert.deepEqual(titles(notes, "test"), ["Tests"]);
  assert.deepEqual(titles(notes, "ключ"), ["Ключи"]);
  assert.deepEqual(titles(notes, "файл"), ["Ключи"]);
  assert.deepEqual(titles(notes, "лог"), ["Логи"]);
  assert.deepEqual(titles([note("Ветки", "Работаю в ветке beta."), note("Other", "x")], "ветка"), ["Ветки"]);
});

test("a note with any of the words is found, even under a much stronger match (review: the 15% cut hid it)", () => {
  const notes = [
    note("Release checklist: deploy, ship, publish, rollout", "Deploy and release: ship it, publish it, roll it out. Release release deploy deploy."),
    note("Как собирать бету", "Перед выкаткой проверь версию; после выкатки смотри логи."),
    note("Lunch", "Where we eat."),
    note("Coffee", "Where we drink.")
  ];
  assert.deepEqual(titles(notes, "deploy release ship publish rollout launch выкатка выпуск релиз"), ["Release checklist: deploy, ship, publish, rollout", "Как собирать бету"]);
});

test("a note holding only words most notes hold is left out, unless every word asked is such a word", () => {
  const notes = [
    note("Phone call on an urgent alert", "Telegram first, then the phone rings."),
    ...Array.from({ length: 10 }, (_, index) => note(`Note ${index}`, "Something on the side, on and on."))
  ];
  assert.deepEqual(titles(notes, "on urgent phone"), ["Phone call on an urgent alert"]);
  assert.equal(titles(notes, "on").length, 11);
});

test("a word in the title weighs more than in the body; a word inside a longer one weighs less", () => {
  assert.deepEqual(titles([note("Plain", "This note says deploy once."), note("Deploy", "This note says nothing else.")], "deploy"), ["Deploy", "Plain"]);
  assert.deepEqual(titles([note("Inside", "The sqliteSession object is shared."), note("Start", "A session starts here.")], "session"), ["Start", "Inside"]);
});

test("scripts without spaces, marks and dotted capitals are found (review findings)", () => {
  assert.deepEqual(titles([note("部署说明", "我们先部署服务器。"), note("Other", "x")], "部署"), ["部署说明"]);
  assert.deepEqual(titles([note("परीक्षण", "यह परीक्षण है"), note("Other", "x")], "परीक्षण"), ["परीक्षण"]);
  const izmir = note("Servers", "The İzmir server is down.");
  assert.deepEqual(titles([izmir, note("Other", "x")], "İzmir"), ["Servers"]);
  assert.match(snippetOf(izmir.body, searchWords("İzmir")), /İzmir/);
});

test("the passage is where most words asked are close together, cut at word edges, within the limit with its marks", () => {
  const filler = "Lorem ipsum dolor sit amet consectetur. ".repeat(20);
  const body = `${filler}The release went out to the beta. ${filler}To deploy the release, run the Release workflow on beta and wait. ${filler}`;
  const snippet = snippetOf(body, searchWords("deploy release workflow"));
  assert.match(snippet, /deploy the release, run the Release workflow/);
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"));
  assert.ok(snippet.length <= MEMORY_SNIPPET_MAX_CHARS, `${snippet.length}`);
  // Starts at a word's start: what follows "…" comes after a space in the body.
  assert.ok(body.replace(/\s+/g, " ").includes(` ${snippet.slice(1, 20)}`));
  // Only the title matched: the body's start.
  assert.equal(snippetOf("Short body.\nSecond line.", searchWords("unrelated")), "Short body. Second line.");
  assert.equal(snippetOf("   ", searchWords("deploy")), "");
  // A body that ends in the middle of a word never loops.
  assert.match(snippetOf(`${"word ".repeat(100)}deploy`, searchWords("deploy")), /deploy$/);
});

test("the passage never holds half of a character (review: an emoji cut in two)", () => {
  const body = `${"😀".repeat(50)}deploy${"😀".repeat(200)}`;
  const snippet = snippetOf(body, searchWords("deploy"));
  assert.match(snippet, /deploy/);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(snippet), "no lone surrogate");
});
