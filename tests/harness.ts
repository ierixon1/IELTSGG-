import assert from 'node:assert/strict';

/**
 * A very small `expect` over `node:assert`.
 *
 * The suite was written against `bun:test`, but Bun is not installed in every
 * environment this repo is worked on in, and a test you cannot run is not a
 * test. `node:test` is available wherever Node is — and Bun implements it too —
 * so the suite now runs on both with no dependency to install. Only the
 * matchers the suite actually uses are implemented; add more as needed rather
 * than reaching for a framework.
 */
export interface Expectation<T> {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toContain(needle: unknown): void;
  toHaveLength(length: number): void;
  toBeGreaterThan(value: number): void;
  toBeGreaterThanOrEqual(value: number): void;
  toBeLessThan(value: number): void;
  toMatch(pattern: RegExp): void;
  toThrow(pattern?: RegExp | string): void;
  readonly not: Omit<Expectation<T>, 'not'>;
}

function build<T>(actual: T, negated: boolean): Expectation<T> {
  const check = (passed: boolean, message: string) => {
    if (passed === negated) {
      assert.fail(negated ? `Expected NOT: ${message}` : message);
    }
  };

  const api: Omit<Expectation<T>, 'not'> = {
    toBe(expected) {
      check(Object.is(actual, expected), `expected ${inspect(actual)} to be ${inspect(expected)}`);
    },
    toEqual(expected) {
      let deepEqual = true;
      try {
        assert.deepStrictEqual(actual, expected);
      } catch {
        deepEqual = false;
      }
      check(deepEqual, `expected ${inspect(actual)} to equal ${inspect(expected)}`);
    },
    toBeTruthy() {
      check(Boolean(actual), `expected ${inspect(actual)} to be truthy`);
    },
    toBeFalsy() {
      check(!actual, `expected ${inspect(actual)} to be falsy`);
    },
    toBeUndefined() {
      check(actual === undefined, `expected ${inspect(actual)} to be undefined`);
    },
    toBeDefined() {
      check(actual !== undefined, `expected value to be defined`);
    },
    toContain(needle) {
      if (typeof actual === 'string') {
        check(actual.includes(String(needle)), `expected string to contain ${inspect(needle)}`);
        return;
      }
      if (Array.isArray(actual)) {
        check(actual.includes(needle), `expected array to contain ${inspect(needle)}`);
        return;
      }
      assert.fail(`toContain expects a string or array, got ${typeof actual}`);
    },
    toHaveLength(length) {
      const value = actual as unknown as { length?: number };
      check(value?.length === length, `expected length ${value?.length} to be ${length}`);
    },
    toBeGreaterThan(value) {
      check(Number(actual) > value, `expected ${inspect(actual)} > ${value}`);
    },
    toBeGreaterThanOrEqual(value) {
      check(Number(actual) >= value, `expected ${inspect(actual)} >= ${value}`);
    },
    toBeLessThan(value) {
      check(Number(actual) < value, `expected ${inspect(actual)} < ${value}`);
    },
    toMatch(pattern) {
      check(pattern.test(String(actual)), `expected ${inspect(actual)} to match ${pattern}`);
    },
    toThrow(pattern) {
      let thrown: unknown;
      try {
        (actual as unknown as () => unknown)();
      } catch (error) {
        thrown = error ?? new Error('thrown');
      }
      if (!thrown) {
        check(false, 'expected function to throw');
        return;
      }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      if (pattern === undefined) {
        check(true, 'expected function to throw');
        return;
      }
      const matches =
        pattern instanceof RegExp ? pattern.test(message) : message.includes(pattern);
      check(matches, `expected thrown message ${inspect(message)} to match ${inspect(pattern)}`);
    },
  };

  return { ...api, get not() { return build(actual, !negated); } } as Expectation<T>;
}

function inspect(value: unknown): string {
  if (typeof value === 'string') return value.length > 200 ? `"${value.slice(0, 200)}…"` : `"${value}"`;
  try {
    const json = JSON.stringify(value);
    return json && json.length > 200 ? `${json.slice(0, 200)}…` : String(json);
  } catch {
    return String(value);
  }
}

export function expect<T>(actual: T): Expectation<T> {
  return build(actual, false);
}
