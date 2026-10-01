/**
 * 离散事件仿真用的事件表：按发生时刻弹出最早事件。
 * 同时刻事件按插入先后（seq）执行，保证结果确定、与种子一一对应。
 */
export type EventKind = 'arrival' | 'departure';

export interface SimEvent {
  kind: EventKind;
  time: number;
  /** 插入序号，同时间时作为平局裁决 */
  seq: number;
}

export class EventList {
  private heap: SimEvent[] = [];
  private counter = 0;

  get size(): number {
    return this.heap.length;
  }

  push(kind: EventKind, time: number): void {
    const event: SimEvent = { kind, time, seq: this.counter++ };
    this.heap.push(event);
    this.siftUp(this.heap.length - 1);
  }

  pop(): SimEvent | undefined {
    const heap = this.heap;
    if (heap.length === 0) return undefined;
    const top = heap[0];
    const last = heap.pop() as SimEvent;
    if (heap.length > 0) {
      heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /**
   * 查看（不弹出）最早事件。时变负荷仿真在段边界据此判断：
   * - 最早事件已越过段末：停止本段，该事件若是 departure 则带入下一段；
   * - 否则正常弹出处理。
   */
  peek(): SimEvent | undefined {
    return this.heap[0];
  }

  /** 段边界需要保序续跑时，导出事件表内容与其插入序号水位 */
  snapshot(): { events: SimEvent[]; counter: number } {
    // 堆数组拷贝即可：同一份堆结构恢复后，比较关系与弹出顺序完全一致
    return { events: this.heap.map((e) => ({ ...e })), counter: this.counter };
  }

  /** 由段边界快照恢复事件表（含插入序号，保证同时刻平局裁决不变） */
  static restore(snapshot: { events: SimEvent[]; counter: number }): EventList {
    const list = new EventList();
    list.heap = snapshot.events.map((e) => ({ ...e }));
    list.counter = snapshot.counter;
    return list;
  }

  private static less(a: SimEvent, b: SimEvent): boolean {
    if (a.time !== b.time) return a.time < b.time;
    return a.seq < b.seq;
  }

  private siftUp(index: number): void {
    const heap = this.heap;
    const event = heap[index];
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!EventList.less(event, heap[parent])) break;
      heap[index] = heap[parent];
      index = parent;
    }
    heap[index] = event;
  }

  private siftDown(index: number): void {
    const heap = this.heap;
    const n = heap.length;
    const event = heap[index];
    while (true) {
      const left = 2 * index + 1;
      const right = left + 1;
      let smallest = index;
      if (left < n && EventList.less(heap[left], heap[smallest])) smallest = left;
      if (right < n && EventList.less(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) break;
      heap[index] = heap[smallest];
      index = smallest;
    }
    heap[index] = event;
  }
}
