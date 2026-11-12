const ALLOWED_SHORT = new Set("i j k e x y z id _ db io ok fs os up to".split(" "));
const VAGUE = new Set(
  (
    "tmp temp val vals res ret ctx cfg usr btn str num obj arr cb el elem idx cnt len buf ptr fn " +
    "msg err data info item items thing stuff foo bar baz handler manager helper util utils " +
    "process handle"
  ).split(" "),
);
const DECLARATION =
  /\b(?:const|let|var|function\s*\*?|class|interface|type|enum|def|func)\s+([A-Za-z_]\w*)/g;

function isVague(name: string): boolean {
  const lowered = name.toLowerCase();
  return !ALLOWED_SHORT.has(lowered) && (name.length <= 2 || VAGUE.has(lowered));
}

const declaredNames = (text: string) => [...text.matchAll(DECLARATION)].map((match) => match[1]);

export function newVagueNames(before: string, after: string): string[] {
  const remaining = declaredNames(before);
  return declaredNames(after).filter((name) => {
    if (!isVague(name)) return false;
    const position = remaining.indexOf(name);
    if (position < 0) return true;
    remaining.splice(position, 1);
    return false;
  });
}
