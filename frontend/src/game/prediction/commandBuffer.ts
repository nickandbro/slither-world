import type { PredictionCommand } from './types'

const INPUT_SEQ_MOD = 0x1_0000
const INPUT_SEQ_HALF_RANGE = INPUT_SEQ_MOD / 2

export const PREDICTION_COMMAND_BUFFER_CAPACITY = 128

export function normalizeInputSeq(value: number): number {
  return value & 0xffff
}

export function nextInputSeq(previous: number | null): number {
  if (previous === null) return 0
  return (previous + 1) & 0xffff
}

export function isInputSeqNewer(candidate: number, baseline: number): boolean {
  const diff = (candidate - baseline + INPUT_SEQ_MOD) % INPUT_SEQ_MOD
  return diff > 0 && diff < INPUT_SEQ_HALF_RANGE
}

export function isInputSeqAcked(seq: number, ackSeq: number): boolean {
  return !isInputSeqNewer(seq, ackSeq)
}

export class PredictionCommandBuffer {
  private readonly capacity: number
  private readonly commands: PredictionCommand[] = []

  constructor(capacity = PREDICTION_COMMAND_BUFFER_CAPACITY) {
    this.capacity = Math.max(8, capacity)
  }

  clear(): void {
    this.commands.length = 0
  }

  size(): number {
    return this.commands.length
  }

  enqueue(command: PredictionCommand): { overflowPruned: number } {
    this.commands.push({
      ...command,
      seq: normalizeInputSeq(command.seq),
    })

    const overflow = this.commands.length - this.capacity
    if (overflow > 0) {
      this.commands.splice(0, overflow)
      return { overflowPruned: overflow }
    }
    return { overflowPruned: 0 }
  }

  pruneAcked(ackSeq: number | null): number {
    if (ackSeq === null || this.commands.length === 0) return 0
    let removed = 0
    while (this.commands.length > 0) {
      const first = this.commands[0]
      if (!first || !isInputSeqAcked(first.seq, ackSeq)) break
      this.commands.shift()
      removed += 1
    }
    return removed
  }

  getPendingAfterAck(ackSeq: number | null): PredictionCommand[] {
    if (ackSeq === null) return this.commands.map((command) => ({ ...command }))
    return this.commands
      .filter((command) => isInputSeqNewer(command.seq, ackSeq))
      .map((command) => ({ ...command }))
  }
}
