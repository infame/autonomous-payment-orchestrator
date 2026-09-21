/**
 * I8 rate limit: the number of intents that ever showed status "completed"
 * must not exceed `policy.dailyRateLimit`. Assumes the whole run falls in a
 * single rate-limit window (one run = one window); it does not model the
 * window sliding. Subjects are the completed intents.
 */
import { violation } from "./types.js";
import type { Oracle } from "./types.js";

export const rateLimit: Oracle = (o) => {
  const completed = o.intents.filter(
    (i) =>
      i.views.some((v) => v.status === "completed") ||
      i.finalView?.status === "completed",
  ).length;
  return {
    id: "I8",
    title: "Daily rate limit",
    subjects: completed,
    violations:
      completed > o.policy.dailyRateLimit
        ? [
            violation(
              "I8",
              `${completed} completed intents exceed the daily rate limit ${o.policy.dailyRateLimit}`,
            ),
          ]
        : [],
  };
};
