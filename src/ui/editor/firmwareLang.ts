// CodeMirror support for firmware: C and C++ highlighting in the app's colours (preprocessor lines, Arduino's own
// names), and completion of the Arduino core and the libraries the simulator runs.

import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";

const KEYWORDS = new Set(
  "auto break case catch class const constexpr continue default delete do else enum explicit extern for friend goto if inline mutable namespace new operator private protected public register return sizeof static static_cast struct switch template this throw try typedef typename union using virtual volatile while".split(" "),
);
const TYPES = new Set(
  "bool boolean byte char double float int long short signed unsigned void word size_t String int8_t uint8_t int16_t uint16_t int32_t uint32_t int64_t uint64_t".split(" "),
);
const ATOMS = new Set(["true", "false", "NULL", "nullptr", "HIGH", "LOW", "INPUT", "OUTPUT", "INPUT_PULLUP", "LED_BUILTIN", "RISING", "FALLING", "CHANGE", "PI", "DEC", "HEX", "BIN", "OCT"]);
const GLOBALS = new Set(["Serial", "Serial1", "Serial2", "Wire", "EEPROM", "SPI", "SD", "FastLED"]);

interface State {
  comment: boolean;
}

function quoted(stream: Parameters<StreamParser<State>["token"]>[0], end: string) {
  while (!stream.eol()) {
    const c = stream.next();
    if (c === "\\") stream.next();
    else if (c === end) return;
  }
}

const parser: StreamParser<State> = {
  name: "kerf-firmware",
  startState: () => ({ comment: false }),
  token(stream, state) {
    if (state.comment) {
      if (stream.skipTo("*/")) {
        stream.pos += 2;
        state.comment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.sol() && stream.match(/^\s*#\s*\w+/)) {
      // #include <Servo.h>, #define NAME value: the directive, then the rest of the line as usual
      return "meta";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.comment = true;
      return "comment";
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      quoted(stream, ch);
      return "string";
    }
    if (ch === "<" && /#\s*include\s*$/.test(stream.string.slice(0, stream.pos))) {
      stream.skipTo(">");
      stream.next();
      return "string";
    }
    if (stream.match(/^(?:0x[\da-f]+|0b[01]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)[ulf]*/i)) return "number";
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const w = stream.current();
      const before = stream.string.slice(0, stream.start);
      if (/(\.|->)\s*$/.test(before)) return "propertyName";
      if (KEYWORDS.has(w)) return "keyword";
      if (TYPES.has(w)) return "typeName";
      if (ATOMS.has(w)) return "bool";
      if (GLOBALS.has(w)) return "namespace";
      if (/^[A-Z][A-Z0-9_]+$/.test(w)) return "atom";
      return "variableName";
    }
    if (stream.match(/^[+\-*/%=<>!&|^~?:]+/)) return "operator";
    stream.next();
    return "punctuation";
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } }, closeBrackets: { brackets: ["(", "[", "{", "'", '"'] } },
};

export const firmwareLanguage = StreamLanguage.define(parser);

/** The Arduino core and library names offered while typing, with what each takes. */
const CORE: [string, string][] = [
  ["pinMode", "(pin, mode)"],
  ["digitalWrite", "(pin, value)"],
  ["digitalRead", "(pin)"],
  ["analogRead", "(pin)"],
  ["analogWrite", "(pin, value)"],
  ["delay", "(ms)"],
  ["delayMicroseconds", "(us)"],
  ["millis", "()"],
  ["micros", "()"],
  ["attachInterrupt", "(digitalPinToInterrupt(pin), handler, mode)"],
  ["detachInterrupt", "(n)"],
  ["digitalPinToInterrupt", "(pin)"],
  ["noInterrupts", "()"],
  ["interrupts", "()"],
  ["tone", "(pin, hz, ms)"],
  ["noTone", "(pin)"],
  ["pulseIn", "(pin, state, timeoutUs)"],
  ["map", "(x, inLow, inHigh, outLow, outHigh)"],
  ["constrain", "(x, low, high)"],
  ["random", "(low, high)"],
  ["randomSeed", "(seed)"],
  ["sprintf", "(buf, fmt, ...)"],
  ["snprintf", "(buf, n, fmt, ...)"],
  ["strcmp", "(a, b)"],
  ["strlen", "(s)"],
  ["memcpy", "(dst, src, n)"],
  ["memset", "(dst, c, n)"],
];
const MEMBERS: Record<string, [string, string][]> = {
  Serial: [["begin", "(baud)"], ["print", "(x)"], ["println", "(x)"], ["printf", "(fmt, ...)"], ["available", "()"], ["read", "()"], ["peek", "()"], ["write", "(b)"], ["readStringUntil", "(c)"], ["parseInt", "()"], ["parseFloat", "()"], ["setTimeout", "(ms)"], ["flush", "()"]],
  Wire: [["begin", "()"], ["setClock", "(hz)"], ["beginTransmission", "(addr)"], ["write", "(b)"], ["endTransmission", "(stop)"], ["requestFrom", "(addr, n)"], ["available", "()"], ["read", "()"]],
  EEPROM: [["read", "(addr)"], ["write", "(addr, v)"], ["update", "(addr, v)"], ["get", "(addr, x)"], ["put", "(addr, x)"], ["length", "()"]],
  SPI: [["begin", "()"], ["beginTransaction", "(SPISettings(hz, MSBFIRST, SPI_MODE0))"], ["transfer", "(b)"], ["transfer16", "(w)"], ["endTransaction", "()"], ["end", "()"]],
  SD: [["begin", "(csPin)"], ["open", '("name", FILE_WRITE)'], ["exists", '("name")'], ["remove", '("name")'], ["mkdir", '("dir")']],
  FastLED: [["addLeds", "<WS2812B, PIN, GRB>(leds, n)"], ["show", "()"], ["clear", "()"], ["setBrightness", "(b)"], ["delay", "(ms)"]],
};
MEMBERS.Serial1 = MEMBERS.Serial;
MEMBERS.Serial2 = MEMBERS.Serial;

export function firmwareCompletions(ctx: CompletionContext): CompletionResult | null {
  const member = ctx.matchBefore(/\b(Serial[12]?|Wire|EEPROM|SPI|SD|FastLED)\.\w*$/);
  if (member) {
    const dot = member.text.indexOf(".");
    const obj = member.text.slice(0, dot);
    return { from: member.from + dot + 1, options: (MEMBERS[obj] ?? []).map(([label, detail]) => ({ label, type: "function", detail })), validFor: /^\w*$/ };
  }
  const word = ctx.matchBefore(/\b[A-Za-z_]\w*$/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  return { from: word.from, options: CORE.map(([label, detail]) => ({ label, type: "function", detail })), validFor: /^\w*$/ };
}
