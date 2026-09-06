import { describe, expect, test } from "bun:test";

import {
  insertTextAtCursor,
  moveCursorLeft,
  moveCursorRight,
  moveCursorWordLeft,
  moveCursorWordRight,
  removeCharacterBeforeCursor,
} from "@/terminal/tui/input-editor";

describe("moveCursorWordLeft", () => {
  test("jumps to start of current word", () => {
    expect(moveCursorWordLeft({ text: "hello world", cursorOffset: 9 })).toEqual({
      text: "hello world",
      cursorOffset: 6,
    });
  });

  test("skips trailing spaces then jumps over word", () => {
    expect(moveCursorWordLeft({ text: "hello world", cursorOffset: 11 })).toEqual({
      text: "hello world",
      cursorOffset: 6,
    });
  });

  test("jumps across multiple spaces", () => {
    expect(moveCursorWordLeft({ text: "foo   bar", cursorOffset: 9 })).toEqual({
      text: "foo   bar",
      cursorOffset: 6,
    });
  });

  test("stops at start of text", () => {
    expect(moveCursorWordLeft({ text: "hello", cursorOffset: 3 })).toEqual({
      text: "hello",
      cursorOffset: 0,
    });
  });

  test("no-op at offset 0", () => {
    expect(moveCursorWordLeft({ text: "hello", cursorOffset: 0 })).toEqual({
      text: "hello",
      cursorOffset: 0,
    });
  });
});

describe("moveCursorWordRight", () => {
  test("jumps to end of current word", () => {
    expect(moveCursorWordRight({ text: "hello world", cursorOffset: 0 })).toEqual({
      text: "hello world",
      cursorOffset: 5,
    });
  });

  test("skips leading spaces then jumps over word", () => {
    expect(moveCursorWordRight({ text: "hello world", cursorOffset: 5 })).toEqual({
      text: "hello world",
      cursorOffset: 11,
    });
  });

  test("jumps across multiple spaces", () => {
    expect(moveCursorWordRight({ text: "foo   bar", cursorOffset: 3 })).toEqual({
      text: "foo   bar",
      cursorOffset: 9,
    });
  });

  test("stops at end of text", () => {
    expect(moveCursorWordRight({ text: "hello", cursorOffset: 2 })).toEqual({
      text: "hello",
      cursorOffset: 5,
    });
  });

  test("no-op at end of text", () => {
    expect(moveCursorWordRight({ text: "hello", cursorOffset: 5 })).toEqual({
      text: "hello",
      cursorOffset: 5,
    });
  });
});

describe("moveCursorLeft / moveCursorRight", () => {
  test("left clamps to 0", () => {
    expect(moveCursorLeft({ text: "hi", cursorOffset: 0 })).toEqual({ text: "hi", cursorOffset: 0 });
  });

  test("right clamps to text length", () => {
    expect(moveCursorRight({ text: "hi", cursorOffset: 2 })).toEqual({ text: "hi", cursorOffset: 2 });
  });
});

describe("insertTextAtCursor", () => {
  test("inserts at middle", () => {
    expect(insertTextAtCursor({ text: "helo", cursorOffset: 3 }, "l")).toEqual({
      text: "hello",
      cursorOffset: 4,
    });
  });
});

describe("removeCharacterBeforeCursor", () => {
  test("removes char before cursor", () => {
    expect(removeCharacterBeforeCursor({ text: "hello", cursorOffset: 5 })).toEqual({
      text: "hell",
      cursorOffset: 4,
    });
  });

  test("no-op at offset 0", () => {
    expect(removeCharacterBeforeCursor({ text: "hello", cursorOffset: 0 })).toEqual({
      text: "hello",
      cursorOffset: 0,
    });
  });
});
