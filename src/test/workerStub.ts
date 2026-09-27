/**
 * Stand-in for a Vite `?worker` import under vitest (#3632). jsdom has no
 * `Worker`, so the constructor only records the options it was given.
 */
export default class WorkerStub {
  constructor(public readonly options?: { name?: string }) {}
}
