// Minimal stand-in for the drizzle query builder used in unit tests.
//
// Each db.select()/db.selectDistinct() call pops the next queued response, so
// a test scripts the exact sequence of result sets the code under test will
// see (the call order in the services is deterministic). Builder methods all
// return the same chainable, and awaiting it resolves to the queued rows.
// Inserts/updates/deletes are recorded so tests can assert on what was written.
//
// Usage:
//   vi.mock('../db/client', async () => {
//     const { FakeDb } = await import('../test/dbMock')
//     return { db: new FakeDb(), closeDb: async () => {} }
//   })
//   const fakeDb = db as unknown as FakeDb

type Rows = Record<string, unknown>[]

export class FakeDb {
  private selectQueue: (Rows | Error)[] = []
  insertedValues: Record<string, unknown>[] = []
  updateCalls: { set: Record<string, unknown> }[] = []
  deleteCount = 0

  /** Queue the result (or an Error to reject with) for the next select call. */
  queueSelect(rowsOrError: Rows | Error): this {
    this.selectQueue.push(rowsOrError)
    return this
  }

  reset(): void {
    this.selectQueue = []
    this.insertedValues = []
    this.updateCalls = []
    this.deleteCount = 0
  }

  private chain(result: Rows | Error) {
    const b: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'limit', 'orderBy', 'leftJoin', 'innerJoin', 'groupBy']) {
      b[m] = () => b
    }
    b.then = (resolve: (rows: Rows) => unknown, reject: (err: Error) => unknown) =>
      result instanceof Error ? Promise.reject(result).catch(reject) : Promise.resolve(result).then(resolve)
    return b
  }

  select(..._cols: unknown[]) {
    return this.chain(this.selectQueue.shift() ?? [])
  }

  selectDistinct(..._cols: unknown[]) {
    return this.chain(this.selectQueue.shift() ?? [])
  }

  insert(_table: unknown) {
    return {
      values: (v: Record<string, unknown> | Record<string, unknown>[]) => {
        this.insertedValues.push(...(Array.isArray(v) ? v : [v]))
        const p = Promise.resolve([]) as unknown as Promise<Rows> & {
          onConflictDoUpdate: (opts: unknown) => { returning: () => Promise<Rows> }
          returning: () => Promise<Rows>
        }
        p.onConflictDoUpdate = () => ({ returning: async () => [{ id: 'fake-id' }] })
        p.returning = async () => [{ id: 'fake-id' }]
        return p
      },
    }
  }

  update(_table: unknown) {
    return {
      set: (patch: Record<string, unknown>) => {
        this.updateCalls.push({ set: patch })
        return { where: async () => [] }
      },
    }
  }

  delete(_table: unknown) {
    this.deleteCount++
    const p = Promise.resolve([]) as unknown as Promise<Rows> & { where: () => Promise<Rows> }
    p.where = async () => []
    return p
  }

  transaction = async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => fn(this)
}
