// Imported FIRST by tests that fire hundreds of requests: the global throttler reads RATE_LIMIT at module load.
process.env.RATE_LIMIT = '100000';
export {};
