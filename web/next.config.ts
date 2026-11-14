import type { NextConfig } from 'next';

// Browser journeys build with a mock sign-in provider in a separate output tree.
const config: NextConfig = { distDir: process.env.DRAIN_TEST_DIST_DIR || '.next' };
export default config;
