import { getTimelineRoutes, type Env } from "./cartrack";

/** Lives only for one cron invocation. Sharing the promise also shares an in-flight
 * read; a later invocation always asks Cartrack again. */
export function createMorningReads() {
  const timelines = new Map<string, ReturnType<typeof getTimelineRoutes>>();
  return {
    timeline(date: string, env: Env) {
      const key = `${env}:${date}`;
      let read = timelines.get(key);
      if (!read) {
        read = getTimelineRoutes(date, env);
        timelines.set(key, read);
        console.log(`[morning-reads] timeline fetch ${key}`);
      } else console.log(`[morning-reads] timeline reuse ${key}`);
      return read;
    },
  };
}

export type MorningReads = ReturnType<typeof createMorningReads>;
