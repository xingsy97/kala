export async function mapWithConcurrency<Input, Output>(
  inputs: readonly Input[],
  limit: number,
  map: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(inputs.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < inputs.length) {
      const index = nextIndex++
      output[index] = await map(inputs[index]!, index)
    }
  }
  const workers = Array.from({ length: Math.min(inputs.length, Math.max(1, Math.floor(limit))) }, () => worker())
  await Promise.all(workers)
  return output
}
