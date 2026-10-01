/**
 * M/M/1/K 生灭过程的瞬态（非稳态）概率分布求解。
 *
 * 方法：均匀化（uniformization，又称 randomization / Jensen 法）。
 *
 * 模型：段内到达率 λ、服务率 μ 为常数，状态 n = 0..K，向前方程
 *   p'(t) = p(t) · Q，Q 是三对角生灭生成元
 * （p 取行向量：p'_n = λ p_{n-1} + μ p_{n+1} - (λ 1{n<K} + μ 1{n>0}) p_n）。
 *
 * 取均匀化速率 α = λ + μ，把生成元写成 Q = α(P − I)，其中 P 是行随机
 * 矩阵（均匀化离散链的一步转移）：
 *   P(n, n+1) = λ/α  (n<K)，P(n, n-1) = μ/α  (n>0)，
 *   对角项补齐到 1。
 * 于是
 *   p(t) = p(0) · exp(Qt) = p(0) · Σ_{m=0}^∞ e^{-αt} (αt)^m/m! · P^m，
 * 即“参数 αt 的 Poisson 个离散链步数”的混合。
 *
 * 为什么选它（放弃了什么），详见 docs/time-varying.md。一句话：P 与
 * Poisson 权重全部非负，只要截断留足尾概率，算出的分布严格非负、质量
 * 归一，λ≫μ、K 到几百也不会出现 NaN 或负概率——这是显式 Euler / RK
 * 类 ODE 解法给不了的保证。
 *
 * 时间平均：段内指标要的是 1/d ∫₀ᵈ f(p(t)) dt。对 f(p)=p_n 这类线性
 * 函数，积分可直接对 Poisson 权重求累积分布：
 *   ∫₀ᵈ p_m(t) dt = 1/α · Σ_{j=0}^m w_j，w_j = e^{-αt} (αt)^j/j!，
 * 因为 ∫₀ᵈ Poisson(αt) 的 pmf_j 求和 dt = (1/α) Σ_{j=0}^m CDF_j。
 * 非线性指标（平均队长、阻塞概率、利用率）都是 p 的线性函数，
 * 同一套“平均分布”即可给出，不必在每个 m 上分别积分。
 *
 * Poisson–Gamma 恒等式：
 *   ∫₀ᵈ e^{-αt}(αt)^m/m! dt = (1/α) · P(Poisson(αd) > m)
 *                           = (1/α) · (1 - Σ_{j=0}^m w_j)，
 * 即每一步 v_m 对“时间平均分布”的权重是 (1/α) 乘 Poisson 尾概率。
 * 校验：Σ_m 权重 = (1/α)·E[N] = (1/α)·αd = d，除以 d 后质量归一。
 */

/** 截断目标：丢掉的 Poisson 尾概率上界 */
const TAIL_TOLERANCE = 1e-13;
/** 单个子步 α·h 的均值上限；超过则把整段切成若干等长子步推进 */
const MAX_MEAN_PER_SUBSTEP = 2_000;
/** 稳态提前退出阈值：段末分布与稳态分布逐状态最大绝对差小于该值即视为已平衡 */
const STEADY_EXIT_TOLERANCE = 1e-12;

/** 求解器单次传播的输出：段末分布 + 段内时间平均分布 */
export interface TransientEvolution {
  /** 段末概率分布 p(d)，长度 K+1 */
  end: number[];
  /** 段内时间平均概率分布 (1/d)∫₀ᵈ p(t) dt，长度 K+1 */
  timeAveraged: number[];
}

/**
 * 计算 Poisson(mean) 的 pmf 序列 w_0..w_M，尾概率（1−CDF）小于
 * tailTolerance 时停止向上展开。
 *
 * 不能直接从 w_0 = e^{-mean} 起步递推：mean 超过约 700 时 e^{-mean}
 * 在 double 里下溢成 0，整条递推全 0（高 λ、长时段就会踩中）。
 * 做法：从众数 m0 = floor(mean) 出发，用对数空间算出不溢出的 w_{m0}
 * （众数处的 pmf 量级只有 ~1/√(2π·mean)，恒为 O(1) 不溢出），再用
 * 比值关系 w_{m-1} = w_m·m/mean、w_{m+1} = w_m·mean/(m+1) 向两侧展开，
 * 向下一直展到 0，向上展到尾概率足够小；最后整体除以 Σw 归一，
 * 消除截断偏差。
 */
function poissonWeights(mean: number, tailTolerance: number): number[] {
  // mean=0（αd 下溢到 0 的极端情形）：Poisson(0) 质量全在 m=0
  if (mean <= 0) return [1];
  const m0 = Math.floor(mean);

  // log(m0!)：log Γ(m0+1) = Σ_{j=1}^{m0} log j（m0 ≤ 数千，成本可忽略）
  let logFactorial = 0;
  for (let j = 2; j <= m0; j++) logFactorial += Math.log(j);
  const logWm0 = -mean + m0 * Math.log(mean) - logFactorial;

  const weights: number[] = new Array<number>(m0 + 1).fill(0);
  weights[m0] = Math.exp(logWm0);

  // 向下展到 0
  let total = weights[m0];
  for (let m = m0; m >= 1; m--) {
    weights[m - 1] = weights[m] * (m / mean);
    total += weights[m - 1];
  }

  // 向上展开，直到未归一尾概率低于阈值；先累加再归一
  let wm = weights[m0];
  let m = m0;
  // 用 1 - 当前总质量估计尾量（未归一总量最终接近 1）
  while (1 - total > tailTolerance) {
    m += 1;
    wm *= mean / m;
    weights.push(wm);
    total += wm;
    if (m > 200_000) break; // 防御性上限
  }

  // 归一化（截断 + 舍入误差一次性消掉，保证 Σw = 1 到机器精度）
  for (let i = 0; i < weights.length; i++) weights[i] /= total;
  return weights;
}

/**
 * 把均匀化离散链推进 m=0..M 步，同时累加：
 * - endMix：按 Poisson 权重混合的末态分布（即 p(d)）；
 * - avgMix：按“Poisson 尾累积 / α / d”权重混合的时间平均分布。
 *
 * 每一步只做一次行向量 × 三对角 P 的稀疏乘法，复杂度 O(K)。
 */
function evolveSubstep(
  initial: Float64Array,
  lambda: number,
  mu: number,
  duration: number,
): TransientEvolution {
  const k = initial.length - 1;
  const alpha = lambda + mu;

  // α = 0（λ = μ = 0）：分布在整个时段内不演化
  if (alpha === 0) {
    const end = Array.from(initial);
    return { end, timeAveraged: end.slice() };
  }

  const mean = alpha * duration;
  const weights = poissonWeights(mean, TAIL_TOLERANCE);
  const up = lambda / alpha;
  const down = mu / alpha;

  let dist = new Float64Array(initial); // 当前 P^m 作用后的分布
  const endMix = new Float64Array(k + 1);
  const avgMix = new Float64Array(k + 1);

  // Σ_{j=0}^m w_j 的递增量；∫₀ᵈ w_m(t)dt = (1/α)(1 − 该累积量)
  let cumulativeWeight = 0;
  for (let m = 0; m < weights.length; m++) {
    const w = weights[m];
    cumulativeWeight += w;
    const endFactor = w;
    const avgFactor = (1 - cumulativeWeight) / alpha; // 未除以 d，最后统一除
    for (let n = 0; n <= k; n++) {
      const pn = dist[n];
      if (pn !== 0) {
        endMix[n] += endFactor * pn;
        avgMix[n] += avgFactor * pn;
      }
    }
    if (m === weights.length - 1) break;

    // dist <- dist · P（稀疏三对角）
    const next = new Float64Array(k + 1);
    for (let n = 0; n <= k; n++) {
      const pn = dist[n];
      if (pn === 0) continue;
      if (n < k) next[n + 1] += pn * up;
      if (n > 0) next[n - 1] += pn * down;
      next[n] += pn * (1 - (n < k ? up : 0) - (n > 0 ? down : 0));
    }
    dist = next;
  }

  const end = sanitize(Array.from(endMix));
  // avgMix 目前是 ∫₀ᵈ p(t) dt 的各分量，除以 d 得到时间平均分布
  const timeAveragedRaw = new Array<number>(k + 1);
  for (let n = 0; n <= k; n++) {
    timeAveragedRaw[n] = avgMix[n] / duration;
  }
  const timeAveraged = sanitize(timeAveragedRaw);
  return { end, timeAveraged };
}

/**
 * 概率向量的数值清洗：
 * - 均匀化本身非负，浮点误差可能产生绝对值 < 1e-12 的“−0 量级”负数，夹到 0；
 * - 归一化误差（截断 + 舍入）在 1e-9 以内时整体重归一；
 * - 超出该预算说明求解器出了问题，直接抛错而不是悄悄掩盖。
 */
function sanitize(probabilities: number[]): number[] {
  let sum = 0;
  let badNegative = false;
  for (const p of probabilities) {
    if (!Number.isFinite(p)) badNegative = true;
    if (p < 0) {
      if (p < -1e-12) badNegative = true;
    } else {
      sum += p;
    }
  }
  if (badNegative || !Number.isFinite(sum) || sum <= 0) {
    throw new Error(
      `瞬态求解出现非有限值或显著负概率（sum=${sum}），请收窄时长/速率范围`,
    );
  }
  let anyNegative = false;
  for (let i = 0; i < probabilities.length; i++) {
    if (probabilities[i] < 0) {
      probabilities[i] = 0;
      anyNegative = true;
    }
  }
  if (anyNegative || Math.abs(sum - 1) > 1e-15) {
    if (Math.abs(sum - 1) > 1e-9) {
      throw new Error(
        `瞬态求解归一化误差过大（|sum-1|=${Math.abs(sum - 1)}）`,
      );
    }
    for (let i = 0; i < probabilities.length; i++) {
      probabilities[i] /= sum;
    }
  }
  return probabilities;
}

/**
 * 一个时段的瞬态演化主入口：从入口分布 initial 出发，按 (λ, μ, K, d)
 * 推进到段末。
 *
 * αd 过大时 Poisson 项数 ~ αd 太多，因此把时长切成若干等长子步，
 * 每子步均值不超过 MAX_MEAN_PER_SUBSTEP。子步只影响运算顺序，
 * 每段的数学结果唯一；整段是入口分布与本段参数的确定性纯函数，
 * 这是“增量重算与完整重算逐位一致”的解析侧基础。
 *
 * 若段内系统已达到稳态（收敛阈值 STEADY_EXIT_TOLERANCE），后续子步的
 * 段末分布与时间平均直接用稳态分布填充——已平衡的链再演化还是同分布，
 * 这对 αd 巨大的拥塞段既是必要的性能保护，也不改变数值结果。
 */
export function evolveSegment(params: {
  initial: number[];
  lambda: number;
  mu: number;
  capacity: number;
  duration: number;
}): TransientEvolution {
  const { initial, lambda, mu, capacity: k, duration } = params;
  if (initial.length !== k + 1) {
    throw new Error('入口分布长度与容量不匹配');
  }

  const alpha = lambda + mu;
  const substeps = Math.max(
    1,
    Math.ceil((alpha * duration) / MAX_MEAN_PER_SUBSTEP),
  );
  const h = duration / substeps;

  let current = new Float64Array(initial);

  // 时间平均分布需要在各子步间按子步时长加权合并
  let averaged = new Array<number>(k + 1).fill(0);
  let averagedTime = 0;

  // 段内 λ、μ 不变，稳态参考分布整段只需计算一次
  const steady = steadyState(lambda, mu, k);

  for (let s = 0; s < substeps; s++) {
    const result = evolveSubstep(current, lambda, mu, h);
    const endArr = Float64Array.from(result.end);

    // 稳态提前退出：本子步段末已平衡，且剩余子步仍用同一段（λ 不变）参数
    let reachedSteady = true;
    for (let n = 0; n <= k; n++) {
      if (Math.abs(result.end[n] - steady[n]) > STEADY_EXIT_TOLERANCE) {
        reachedSteady = false;
        break;
      }
    }

    if (reachedSteady && s < substeps - 1) {
      // 当前子步的时间平均仍按真实演化计入（前半段在爬坡）
      for (let n = 0; n <= k; n++) averaged[n] += result.timeAveraged[n] * h;
      averagedTime += h;
      // 剩余子步全程处于稳态：平均分布与段末分布都是稳态分布
      const remaining = duration - (s + 1) * h;
      for (let n = 0; n <= k; n++) averaged[n] += steady[n] * remaining;
      averagedTime += remaining;
      current = Float64Array.from(steady);
      break;
    }

    for (let n = 0; n <= k; n++) averaged[n] += result.timeAveraged[n] * h;
    averagedTime += h;
    current = endArr;
  }

  const end = sanitize(Array.from(current));
  let timeAveraged: number[];
  if (averagedTime === 0) {
    timeAveraged = end.slice();
  } else {
    for (let n = 0; n <= k; n++) averaged[n] /= averagedTime;
    timeAveraged = sanitize(averaged);
  }
  return { end, timeAveraged };
}

/**
 * 本段 (λ, μ, K) 的稳态分布，用于提前退出判定。
 * 复用与老解析接口完全相同的几何级数公式（对数空间平移，不溢出）。
 */
export function steadyState(lambda: number, mu: number, k: number): number[] {
  const rho = mu === 0 ? Infinity : lambda / mu;
  const probabilities = new Array<number>(k + 1);
  if (rho === 1) {
    probabilities.fill(1 / (k + 1));
    return probabilities;
  }
  // λ=0（rho=0）：除 n=0 外权重全为 0，走同一套归一化即可
  const logRho = rho > 0 && Number.isFinite(rho) ? Math.log(rho) : rho === 0 ? 0 : NaN;
  const maxLog = rho > 1 ? k * logRho : 0;
  let partition = 0;
  for (let n = 0; n <= k; n++) {
    let weight: number;
    if (rho === 0) {
      weight = n === 0 ? 1 : 0;
    } else if (!Number.isFinite(rho)) {
      // μ = 0 且 λ > 0：稳态质量全在 K
      weight = n === k ? 1 : 0;
    } else {
      weight = Math.exp(n * logRho - maxLog);
    }
    probabilities[n] = weight;
    partition += weight;
  }
  for (let n = 0; n <= k; n++) probabilities[n] /= partition;
  return probabilities;
}

/**
 * 由一段的时间平均分布推导段内解析指标（线性泛函，口径同老解析接口）。
 * 阻塞/队长/利用率都只取决于分布本身，不直接需要 λ、μ。
 */
export function averageMetrics(probabilities: number[]): {
  blockingProbability: number;
  meanNumberInSystem: number;
  meanNumberWaiting: number;
  utilization: number;
} {
  const k = probabilities.length - 1;
  let meanNumberInSystem = 0;
  let meanNumberWaiting = 0;
  for (let n = 0; n <= k; n++) {
    const p = probabilities[n];
    meanNumberInSystem += n * p;
    meanNumberWaiting += Math.max(n - 1, 0) * p;
  }
  return {
    blockingProbability: probabilities[k],
    meanNumberInSystem,
    meanNumberWaiting,
    utilization: 1 - probabilities[0],
  };
}
