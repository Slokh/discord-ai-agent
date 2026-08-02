export async function readPostTransferBalances<T>(input: {
  source: () => Promise<T>;
  destination: () => Promise<T>;
  onFailure: (side: "source" | "destination", error: unknown) => Promise<void>;
}): Promise<[T | null, T | null]> {
  return Promise.all([
    readBalance("source", input.source, input.onFailure),
    readBalance("destination", input.destination, input.onFailure),
  ]);
}

async function readBalance<T>(
  side: "source" | "destination",
  read: () => Promise<T>,
  onFailure: (side: "source" | "destination", error: unknown) => Promise<void>,
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    await onFailure(side, error);
    return null;
  }
}
