/**
 * @horus/stitcher — the queue-boundary stitcher. The ONE supplemental layer in v0.
 *
 * Axon's static flow graph terminates at the queue boundary: a producer's
 * `queue.add('x')` is never connected to the consumer's `@Processor('x')`. This pass
 * parses queue-name literals out of Axon's `content` and synthesizes
 * `producer →[enqueues]→ queue →[consumed_by]→ worker` edges into `queue_edges`.
 *
 * Implemented in the STITCH ticket. See architecture.md §2.3.
 */

export * from './extract.js';
export * from './stitch.js';
