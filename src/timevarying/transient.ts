/**
 * M/M/1/K 生灭过程的瞬态（非稳态）求解：均匀化（uniformization / randomization）。
 *
 * 给定段内恒定到达率 λ、服务率 μ、容量 K，以及段初人数分布 p(0)，
 * 求段内的时间平均指标与段末分布 p(T)。
 *
 * 状态 n = 0..K 的生成元 Q（生率 λ、灭率 μ，n=K 时到达被截断）：
 *   q_{n,n+1} = λ (n<K)，q_{n,n-1} = μ (n>0)，q_{n,n} = -（行内其余之和）。
 *
 * 均匀化取 α = λ + μ（生灭过程的最大离去率，永不小于任何 -q_nn），
 * 离散转移矩阵 P = I + Q/α 是行随机矩阵：
 *   P_{n,n+1} = λ/α, P_{n,n-1} = μ/α，
 *   端点处被截断的概率质量落到 P_{n,n}（0 状态 P_00 = μ/α；
 *   K 状态 P_KK = λ/α）。
 * Kolmogorov 方程的解展开为 Poisson 混合：
 *   p(T) = p(0) · Σ_{m>=0} e^{-αT}(αT)^m/m! · P^m。
 *
 * 时间平均量（段内均值）用积分形式：
 *   ∫_0^T p(t) dt / T = Σ_{m>=0} w_m · P^m，其中
 *   w_m = (1/(αT)) · P{N(αT) > m}，N ~ Poisson(αT)（w_0..w_M 之和为 1）。
 * 于是段内平均分布与段末分布可以在同一条“逐次乘 P”的递推链上一并累加，
 * 每一步只做一次 (K+1) 维三对角矩阵-向量乘，共 M+1 步。
 *
 * 数值方法取舍（详见 TIMEVARYING.md）：
 * - 选用均匀化：P 是随机矩阵（元素非负、行和为 1），整条递推保持概率非负、
 *   质量守恒，无条件稳定，不存在显式积分的步长约束，也没有隐式积分的线性
 *   方程组求解；λ≫μ、K 到几百都不会出现 NaN/负数；泊松截断是唯一截断误差，
 *   截断阈值固定在 1e-14。
 * - 放弃显式 Euler/RK：刚性条件 Δt ≤ 1/(λ+μ)，αT 大时步数过多且概率易变负；
 *   放弃矩阵指数 expm(QT)（缩放-平方 + Padé，K 大时代价 O(K^3) 且可能出负）；
 *   放弃纯特征分解（非对称三对角的特征向量可能病态，ρ 大时不稳）。
 */

/** 均匀化允许的单段 αT 上限（= 单段均匀化迭代步数上限的量级） */
export const MAX_ALPHA_T = 200_000;

/** 泊松截断后的尾部总概率上限（唯一截断误差来源） */
const POISSON_TAIL = 1e-14;

/** 均匀化迭代步数的硬性安全阀（正常情况下由尾部阈值先停止） */
const MAX_STEPS_HARD = 250_000;

export interface TransientInput {
  lambda: number;
  mu: number;
  capacity: number;
  duration: number;
  /** 段初人数分布，长度 K+1，元素非负、和为 1 */
  initial: number[];
}

/**
 * 稳定地计算截断泊松权重 a_m = e^{-a} a^m/m!（m = 众数..向两侧展开），
 * 再归一化。众数处直接置 1，相邻权重由比值递推，全程不经过 e^{-a}
 * （a 很大时 e^{-a} 直接下溢为 0，从 m=0 正向递推会整列变 0）。
 */
function poissonWeights(mean: number, maxM: number): number[] {
  const weights = new Array<number>(maxM + 1).fill(0);
  // 泊松众数 floor(mean)（mean 为整数时众数有 mean、mean-1 两个，取其一即可）
  const mode = Math.min(Math.floor(mean), maxM);
  weights[mode] = 1;
  // 向大 m 展开：w_{m+1}/w_m = mean/(m+1)
  for (let m = mode; m < maxM; m++) {
    weights[m + 1] = (weights[m] * mean) / (m + 1);
  }
  // 向小 m 展开：w_{m-1}/w_m = m/mean（mean=0 时 mode=0，此循环不执行）
  for (let m = mode; m > 0; m--) {
    weights[m - 1] = (weights[m] * m) / mean;
  }
  let sum = 0;
  for (const w of weights) sum += w;
  for (let m = 0; m <= maxM; m++) weights[m] /= sum;
  return weights;
}

/**
 * 对三对角随机矩阵 P 做一次行向量右乘 v' = v · P。
 * up = λ/α，down = μ/α，对角线吸收端点处被截断的质量。
 */
function applyTransition(
  v: number[],
  out: number[],
  up: number,
  down: number,
  k: number,
): void {
  out.fill(0);
  // n = 0：P_00 = down（μ/α），P_01 = up
  out[0] += v[0] * down;
  out[1] += v[0] * up;
  for (let n = 1; n < k; n++) {
    const x = v[n];
    out[n - 1] += x * down;
    out[n + 1] += x * up;
  }
  // n = K：P_{K,K-1} = down，P_KK = up（λ/α）
  if (k >= 1) {
    out[k - 1] += v[k] * down;
    out[k] += v[k] * up;
  } else {
    // K = 0 的退化边界（capacity 正整数，实际不会到这里，留作完备）
    out[0] += v[0] * up;
  }
}

/** 把数值噪声清理为合法分布：夹掉微小负值再归一化；明显非法则抛错 */
function sanitizeDistribution(p: number[], context: string): number[] {
  let sum = 0;
  let mostNegative = 0;
  for (const x of p) {
    if (!Number.isFinite(x)) {
      throw new Error(`瞬态求解在 ${context} 出现非有限数值`);
    }
    if (x < mostNegative) mostNegative = x;
    sum += x;
  }
  if (!(sum > 0) || mostNegative < -1e-9) {
    throw new Error(
      `瞬态分布在 ${context} 退化（sum=${sum}, min=${mostNegative}），输入参数可能超出数值适用范围`,
    );
  }
  // 只有 -1e-9..0 量级的舍入负值才允许夹到 0，然后重新归一化
  let s = 0;
  for (let n = 0; n < p.length; n++) {
    if (p[n] < 0) p[n] = 0;
    s += p[n];
  }
  for (let n = 0; n < p.length; n++) p[n] /= s;
  return p;
}

export interface TransientOutput {
  /** 段末人数分布 p_n(T) */
  endDistribution: number[];
  /** 段内时间平均阻塞概率 */
  blockingProbability: number;
  /** 段内时间平均平均队长（含服务中） */
  meanNumberInSystem: number;
  /** 段内时间平均排队人数 */
  meanNumberWaiting: number;
  /** 段内时间平均利用率 */
  utilization: number;
  /** 实际使用的泊松截断步数（诊断用） */
  steps: number;
  /** 截断尾部估计（诊断用） */
  tail: number;
}

export function evolveSegment(input: TransientInput): TransientOutput {
  const { lambda, mu, capacity: k, duration: T } = input;
  const initial = input.initial;

  if (initial.length !== k + 1) {
    throw new Error('initial 分布长度必须为 capacity + 1');
  }
  if (!(T > 0) || !Number.isFinite(T)) {
    throw new Error('duration 必须为正数');
  }

  const alpha = lambda + mu;

  // λ=0 且 μ=0 理论上不会发生（mu 整条曲线 > 0，lambda 可为 0），
  // 但 α=0 时系统冻结，直接返回初值口径的常量结果。
  if (alpha === 0) {
    const p = sanitizeDistribution(initial.slice(), 'α=0 冻结段');
    return finalize(p, p, T, 0, 0);
  }

  const aT = alpha * T;
  if (aT > MAX_ALPHA_T) {
    throw new Error(
      `单段 (λ+μ)·duration = ${aT} 超过均匀化上限 ${MAX_ALPHA_T}，请缩短该段时长或降低速率`,
    );
  }

  // ---- 1. 确定泊松截断 M：使尾部 P{N > M} <= POISSON_TAIL ------------
  // Chernoff 上界 P{N >= x} <= exp(-x ln(x/a) + x - a)（x > a），
  // 从 max(a,1) 起按 1.05 倍向外试探到上界以下，再线性回收精确的 M。
  const findCutoff = (a: number): number => {
    if (a === 0) return 0;
    let x = Math.max(a, 1);
    const tailBound = (xx: number): number =>
      Math.exp(-xx * Math.log(xx / a) + xx - a);
    while (tailBound(x) > POISSON_TAIL && x < MAX_STEPS_HARD) {
      x = Math.min(MAX_STEPS_HARD, Math.ceil(x * 1.05 + 1));
    }
    let m = Math.ceil(x);
    while (m > 0 && tailBound(m) <= POISSON_TAIL) m--;
    return Math.min(Math.max(m + 1, Math.ceil(a)), MAX_STEPS_HARD);
  };

  const M = findCutoff(aT);

  // ---- 2. 归一化泊松权重 a_m（用于段末分布） --------------------------
  const poisson = poissonWeights(aT, M);

  // ---- 3. 由 a_m 反推时间平均权重 w_m = P{N > m} / aT ------------------
  // 生存概率 S_m = Σ_{j>m} a_j，自右向左累加；w_m = S_m / aT。
  // Σ_m w_m = E[N]/aT = 1，因此 {w_m} 是“段内平均分布”的合法混合权重。
  const timeWeight = new Array<number>(M + 1);
  let survival = 0;
  for (let m = M; m >= 0; m--) {
    timeWeight[m] = survival / aT;
    survival += poisson[m];
  }
  const tail = Math.max(0, 1 - survival); // 截断掉的尾部总质量（≈ Chernoff 上界以内）

  // ---- 4. 沿 v ← v·P 递推，同时加权累加段末分布与段内平均分布 ----------
  const up = lambda / alpha;
  const down = mu / alpha;

  const start = sanitizeDistribution(initial.slice(), '段初');

  let v = start.slice();
  let endAcc = new Array<number>(k + 1);
  let avgAcc = new Array<number>(k + 1);
  let next = new Array<number>(k + 1);

  // m = 0：P^0 = I
  for (let n = 0; n <= k; n++) {
    endAcc[n] = poisson[0] * v[n];
    avgAcc[n] = timeWeight[0] * v[n];
  }
  for (let m = 1; m <= M; m++) {
    applyTransition(v, next, up, down, k);
    const tmp = v;
    v = next;
    next = tmp;
    const wEnd = poisson[m];
    const wAvg = timeWeight[m];
    for (let n = 0; n <= k; n++) {
      endAcc[n] += wEnd * v[n];
      avgAcc[n] += wAvg * v[n];
    }
  }

  endAcc = sanitizeDistribution(endAcc, '段末');
  // 平均分布理论上也是概率分布（权重和为 1），同样做一次舍入清理
  avgAcc = sanitizeDistribution(avgAcc, '段内平均');

  return finalize(endAcc, avgAcc, T, M, tail);
}

function finalize(
  endP: number[],
  avgP: number[],
  T: number,
  steps: number,
  tail: number,
): TransientOutput {
  const k = endP.length - 1;
  let meanNumberInSystem = 0;
  let meanNumberWaiting = 0;
  for (let n = 0; n <= k; n++) {
    meanNumberInSystem += n * avgP[n];
    meanNumberWaiting += Math.max(n - 1, 0) * avgP[n];
  }
  return {
    endDistribution: endP,
    blockingProbability: avgP[k],
    meanNumberInSystem,
    meanNumberWaiting,
    utilization: 1 - avgP[0],
    steps,
    tail,
  };
}
