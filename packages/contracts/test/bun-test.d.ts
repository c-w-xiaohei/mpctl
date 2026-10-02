declare module "bun:test" {
  export function describe(name: string, callback: () => void): void;
  export function test(name: string, callback: () => void): void;
  export const expect: (actual: unknown) => {
    toBe(expected: unknown): void;
    toBeInstanceOf(expected: new (...args: never[]) => unknown): void;
    toEqual(expected: unknown): void;
    toThrow(): void;
  };
}
