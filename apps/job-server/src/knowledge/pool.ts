/**
 * Work through items fetched a batch at a time with a pool of workers, each
 * taking the next item as soon as it is done with one, so `size()` stay in
 * flight until nothing more is due. The next batch is fetched ahead, while the
 * last items of the one before are still being worked, so no worker waits for
 * a slow one or for the fetch.
 *
 * `fetch` returns the next batch, empty when nothing more is due (which ends
 * the fetching; items already fetched are still worked). `size` is read after
 * each fetch: the pool grows to it, and a worker past it stops after its item.
 * Once `inTime` is false no item is started; ones fetched but not started are
 * left for the caller's next run. A failed fetch is thrown when the pool runs
 * dry, ending the run.
 */
export async function runPool<T>({
  fetch,
  work,
  size,
  inTime,
}: {
  fetch: () => Promise<T[]>;
  work: (item: T) => Promise<void>;
  size: () => number;
  inTime: () => boolean;
}): Promise<void> {
  const queue: T[] = [];
  let exhausted = false;
  let fetching: Promise<void> | null = null;
  let active = 0;
  const workers: Promise<void>[] = [];
  // A worker's failure, kept until every worker has settled so none is left running.
  let failure: { error: unknown } | undefined;

  const grow = () => {
    while (active < size()) {
      active++;
      workers.push(
        worker().catch((error) => {
          failure ??= { error };
        })
      );
    }
  };
  const fetchMore = () => {
    fetching ??= fetch()
      .then((batch) => {
        if (batch.length === 0) exhausted = true;
        queue.push(...batch);
        grow();
      })
      .finally(() => {
        fetching = null;
      });
    return fetching;
  };
  const next = async (): Promise<T | undefined> => {
    while (queue.length === 0 && !exhausted && inTime()) await fetchMore();
    if (!inTime()) return undefined;
    const item = queue.shift();
    // Fetch ahead; a failure here is met again, and thrown, when the queue runs dry.
    if (queue.length < size() && !exhausted) fetchMore().catch(() => {});
    return item;
  };
  async function worker(): Promise<void> {
    try {
      for (let item = await next(); item !== undefined; item = await next()) {
        await work(item);
        if (active > size()) break; // fewer asked for since
      }
    } finally {
      active--;
    }
  }

  await fetchMore();
  for (let i = 0; i < workers.length; i++) await workers[i];
  if (failure) throw failure.error;
}
