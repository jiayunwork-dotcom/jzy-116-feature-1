import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRegisterInput,
  parseAddVersionInput,
  validateCurveId,
  validateVersion,
  TimvarValidationError,
  TIMVAR_LIMITS,
} from '../src/timvar/validation.js';

const validSegment = { duration: 10, lambda: 5 };

function expectFields(body: Record<string, unknown>): Record<string, string> {
  try {
    parseRegisterInput(body);
    throw new Error('应当抛错');
  } catch (err) {
    assert.ok(err instanceof TimvarValidationError);
    return err.fields;
  }
}

test('合法登记请求通过，默认种子为 1', () => {
  const parsed = parseRegisterInput({
    mu: 10,
    capacity: 5,
    segments: [validSegment],
  });
  assert.equal(parsed.seed, 1);
  assert.equal(parsed.mu, 10);
  assert.equal(parsed.capacity, 5);

  const withSeed = parseRegisterInput({
    mu: 1,
    capacity: 1,
    seed: 0,
    segments: [validSegment],
  });
  assert.equal(withSeed.seed, 0);
});

test('λ=0 合法（该时段无到达），λ<0 非法', () => {
  assert.doesNotThrow(() =>
    parseRegisterInput({ mu: 10, capacity: 5, segments: [{ duration: 3, lambda: 0 }] }),
  );
  const fields = expectFields({
    mu: 10,
    capacity: 5,
    segments: [{ duration: 3, lambda: -1 }],
  });
  assert.ok(fields['segments[0].lambda']);
});

test('时段时长非正报错并指出具体段', () => {
  const fields = expectFields({
    mu: 10,
    capacity: 5,
    segments: [validSegment, { duration: 0, lambda: 5 }],
  });
  assert.ok(fields['segments[1].duration']);

  const neg = expectFields({
    mu: 10,
    capacity: 5,
    segments: [{ duration: -2, lambda: 5 }],
  });
  assert.ok(neg['segments[0].duration']);
});

test('μ 非正、capacity 非正整数报错', () => {
  assert.ok(expectFields({ mu: 0, capacity: 5, segments: [validSegment] }).mu);
  assert.ok(expectFields({ mu: -1, capacity: 5, segments: [validSegment] }).mu);
  assert.ok(
    expectFields({ mu: 10, capacity: 0, segments: [validSegment] }).capacity,
  );
  assert.ok(
    expectFields({ mu: 10, capacity: 2.5, segments: [validSegment] }).capacity,
  );
});

test('种子超出 uint32 或非整数报错', () => {
  assert.ok(
    expectFields({ mu: 1, capacity: 1, seed: -1, segments: [validSegment] }).seed,
  );
  assert.ok(
    expectFields({
      mu: 1,
      capacity: 1,
      seed: TIMVAR_LIMITS.MAX_SEED + 1,
      segments: [validSegment],
    }).seed,
  );
  assert.ok(
    expectFields({ mu: 1, capacity: 1, seed: 1.5, segments: [validSegment] }).seed,
  );
});

test('时段数为 0 或超过上限报错', () => {
  assert.ok(expectFields({ mu: 1, capacity: 1, segments: [] }).segments);
  assert.ok(
    expectFields({
      mu: 1,
      capacity: 1,
      segments: new Array(TIMVAR_LIMITS.MAX_SEGMENTS + 1).fill(validSegment),
    }).segments,
  );
});

test('单段时长 / 总时长 / 容量 / 速率超上限报错', () => {
  // 单段 1001 超单段上限（同时也超总时长上限 10000？不，1001<10000）
  assert.ok(
    expectFields({
      mu: 1,
      capacity: 1,
      segments: [{ duration: TIMVAR_LIMITS.MAX_SEGMENT_DURATION + 1, lambda: 1 }],
    })['segments[0].duration'],
  );
  // 各段都不超单段上限，但总和超总时长上限 → 汇总到 segments
  assert.ok(
    expectFields({
      mu: 1,
      capacity: 1,
      segments: new Array(11).fill({ duration: 950, lambda: 1 }),
    }).segments,
  );
  assert.ok(
    expectFields({
      mu: 1,
      capacity: TIMVAR_LIMITS.MAX_CAPACITY + 1,
      segments: [validSegment],
    }).capacity,
  );
  assert.ok(
    expectFields({
      mu: TIMVAR_LIMITS.MAX_RATE + 1,
      capacity: 1,
      segments: [validSegment],
    }).mu,
  );
  assert.ok(
    expectFields({
      mu: 1,
      capacity: 1,
      segments: [{ duration: 1, lambda: TIMVAR_LIMITS.MAX_RATE + 1 }],
    })['segments[0].lambda'],
  );
});

test('新增版本不允许改 μ / K / seed（整条曲线固定）', () => {
  assert.throws(
    () => parseAddVersionInput({ segments: [validSegment], mu: 2 }),
    /服务率、容量、种子/,
  );
  assert.throws(
    () => parseAddVersionInput({ segments: [validSegment], capacity: 3 }),
    /服务率、容量、种子/,
  );
  assert.throws(
    () => parseAddVersionInput({ segments: [validSegment], seed: 9 }),
    /服务率、容量、种子/,
  );
  // 正常只提交 segments
  assert.doesNotThrow(() =>
    parseAddVersionInput({ segments: [validSegment, { duration: 2, lambda: 0 }] }),
  );
});

test('curveId / version 格式校验', () => {
  assert.equal(validateCurveId('12345678-1234-1234-1234-123456789abc'),
    '12345678-1234-1234-1234-123456789abc');
  assert.throws(() => validateCurveId('../etc/passwd'));
  assert.throws(() => validateCurveId('a'));
  assert.equal(validateVersion(3), 3);
  assert.throws(() => validateVersion(0));
  assert.throws(() => validateVersion(-1));
  assert.throws(() => validateVersion(1.5));
});

test('错误对象同时带 message 与 fields 字段说明', () => {
  // mu 合法、仅段内字段非法时，错误精确到具体段的字段
  let caught: TimvarValidationError | undefined;
  try {
    parseRegisterInput({
      mu: 10,
      capacity: 5,
      segments: [
        { duration: 3, lambda: 5 },
        { duration: -1, lambda: -2 },
      ],
    });
  } catch (err) {
    caught = err as TimvarValidationError;
  }
  assert.ok(caught);
  assert.equal(typeof caught!.message, 'string');
  assert.ok(caught!.fields['segments[1].duration']);
  assert.ok(caught!.fields['segments[1].lambda']);

  // μ 非法时精确到 mu 字段
  assert.throws(
    () => parseRegisterInput({ mu: -1, capacity: 5, segments: [{ duration: 3, lambda: 5 }] }),
    (err: unknown) => err instanceof TimvarValidationError &&
      Boolean((err as TimvarValidationError).fields.mu),
  );
});
