import { useEffect, useState } from "react";

/**
 * 返回单调递增的 `time` 值（毫秒），按约 `intervalMs` 的节奏更新。
 * 传入 `null` 可暂停时钟。用于驱动终端 UI 的 spinner / shimmer 动画。
 */
export function useAnimationFrame(intervalMs: number | null = 50): number {
  const [time, setTime] = useState(0);

  useEffect(() => {
    if (intervalMs === null) return;

    const id = setInterval(() => {
      setTime((prev) => prev + intervalMs);
    }, intervalMs);

    return () => clearInterval(id);
  }, [intervalMs]);

  return time;
}
