// Bun orchestration only: production operations stays real; native transaction and
// worker acceptance is exclusively operations.spec.ts/idempotency.spec.ts in Chromium.
export function installIdbFixture() {
  const previous = globalThis.indexedDB;
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  const factory = {
    open(name: string) {
      const request: any = {};
      queueMicrotask(() => {
        let stores = databases.get(name);
        const fresh = !stores;
        if (!stores) {
          stores = new Map();
          databases.set(name, stores);
        }
        const db = {
          close() {},
          createObjectStore(name: string) {
            stores!.set(name, new Map());
            return store(stores!.get(name)!, undefined);
          },
          transaction(_names: string[] | string, _mode?: string) {
            const tx: any = {};
            const rollback = structuredClone(stores!);
            let pending = 0;
            let aborted = false;
            let finished = false;
            const complete = () =>
              queueMicrotask(() => {
                if (!pending && !aborted && !finished) {
                  finished = true;
                  tx.oncomplete?.();
                }
              });
            tx.abort = () => {
              if (finished) throw new Error("inactive transaction");
              aborted = true;
              stores = rollback;
              databases.set(name, rollback);
              queueMicrotask(() => tx.onabort?.());
            };
            const enqueue = (run: () => unknown) => {
              pending++;
              const request: any = {};
              queueMicrotask(() => {
                try {
                  request.result = run();
                  request.onsuccess?.();
                } catch (error) {
                  request.error = error;
                  tx.onerror?.();
                  tx.abort();
                } finally {
                  pending--;
                  complete();
                }
              });
              return request;
            };
            tx.objectStore = (name: string) => store(stores!.get(name)!, enqueue);
            complete();
            return tx;
          },
        };
        request.result = db;
        if (fresh) request.onupgradeneeded?.({ oldVersion: 0 });
        request.onsuccess?.();
      });
      return request;
    },
  };
  function store(values: Map<string, unknown>, enqueue?: (run: () => unknown) => any): any {
    const run =
      enqueue ??
      ((work: () => unknown) => {
        work();
        return {};
      });
    const write = (value: any, key?: string) => {
      values.set(key ?? value.snapshot.operationId, structuredClone(value));
      return key;
    };
    return {
      get: (key: string) => run(() => structuredClone(values.get(key))),
      getAll: () => run(() => structuredClone([...values.values()])),
      count: () => run(() => values.size),
      delete: (key: string) => run(() => values.delete(key)),
      put: (value: unknown, key?: string) => run(() => write(value, key)),
      add: (value: unknown, key?: string) => run(() => write(value, key)),
      openCursor() {
        const request: any = {};
        const items = [...values.entries()];
        let index = 0;
        const next = () =>
          run(() => {
            const item = items[index++];
            request.result = item
              ? {
                  value: structuredClone(item[1]),
                  primaryKey: item[0],
                  update: (value: unknown) =>
                    run(() => values.set(item[0], structuredClone(value))),
                  continue: next,
                }
              : null;
            request.onsuccess?.();
          });
        next();
        return request;
      },
    };
  }
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: factory });
  return () =>
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: previous });
}
