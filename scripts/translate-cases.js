/**
 * Regression corpus for the translation pipeline: end-to-end cases from raw
 * model output to final args, through sanitize -> tokenize -> the real
 * runTranslationPipeline order. Headless, no model needed.
 *
 * Every user-reported translation failure becomes a case here: set
 * `instruction` (+ `duration`) to the request and `modelRaw` to what the
 * model actually emitted (check the logs - failures now carry it), then pin
 * the correct `expectedArgs`. `inputFile` defaults to /v/clip.mp4; the
 * placeholder `-i input.mp4` in raws exercises the input rewrite.
 */
const TRANSLATE_CASES = [
  {
    name: 'last-remove with scale filter',
    instruction: 'Convert to mkv, trim the last 5 seconds, make it 360p',
    duration: 27.49,
    modelRaw: '-i input.mp4 -ss 00:00:00 -t 00:00:05 -vf scale=-2:360 -c:v libx264 -c:a aac clip-out.mkv',
    expectedArgs: ['-i', '/v/clip.mp4', '-t', '22.49', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-c:a', 'aac', 'clip-out.mkv'],
  },
  {
    name: 'last-keep rewrites -ss/-t',
    instruction: 'keep the last 5 seconds',
    duration: 27.49,
    modelRaw: '-i input.mp4 -ss 00:00:00 -t 00:00:05 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-ss', '22.49', 'clip-out.mp4'],
  },
  {
    name: 'last-keep drops truncating -t',
    instruction: 'keep the last 5 seconds',
    duration: 27.49,
    modelRaw: '-i input.mp4 -ss 22.49 -t 2 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-ss', '22.49', 'clip-out.mp4'],
  },
  {
    name: 'middle inserts center cut',
    instruction: 'Keep the middle 5 seconds, make it muted',
    duration: 60,
    modelRaw: '-i input.mp4 -an clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-an', '-ss', '27.5', '-t', '5', 'clip-out.mp4'],
  },
  {
    name: 'middle leaves correct cut alone',
    instruction: 'keep the middle 5 seconds',
    duration: 60,
    modelRaw: '-i input.mp4 -ss 27.5 -t 5 -an clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-ss', '27.5', '-t', '5', '-an', 'clip-out.mp4'],
  },
  {
    name: 'full request: middle + mute + 720p + greyscale',
    instruction: 'Keep the middle 5 seconds, make it muted, convert to 720p, and make it greyscale',
    duration: 60,
    modelRaw: '-i input.mp4 -ss 27.5 -t 5 -vf scale=-2:720,hue=s=0 -an clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-ss', '27.5', '-t', '5', '-vf', 'scale=-2:720,hue=s=0', '-an', 'clip-out.mp4'],
  },
  {
    name: 'chit-chat wrapped command',
    instruction: 'Convert to mp4',
    duration: 30,
    modelRaw: 'Hi there! Here is your command:\n-i input.mp4 -c:v libx264 -c:a aac clip-out.mp4\nLet me know!',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', '-c:a', 'aac', 'clip-out.mp4'],
  },
  {
    name: 'fenced answer with binary name',
    instruction: 'convert to mp4',
    duration: 30,
    modelRaw: '```bash\nffmpeg -i input.mp4 -c:v libx264 out.mp4\n```',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', 'out.mp4'],
  },
  {
    name: 'thinking trace stripped',
    instruction: 'convert to mp4',
    duration: 30,
    modelRaw: '<think>let me reason about codecs</think>\n-i input.mp4 -c:v libx264 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', 'clip-out.mp4'],
  },
  {
    name: 'size cap computed and inserted',
    instruction: 'Convert to 1080p mp4 below 100MB',
    duration: 60,
    modelRaw: '-i input.mp4 -vf scale=-2:1080 -c:v libx264 -c:a aac -movflags +faststart clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-vf', 'scale=-2:1080', '-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart',
      '-b:v', '13573k', '-maxrate', '13573k', '-bufsize', '27146k', 'clip-out.mp4'],
  },
  {
    name: 'size cap bounds copied audio',
    instruction: 'convert below 50MB',
    duration: 60,
    modelRaw: '-i input.mp4 -c:v libx264 -c:a copy clip-out.mkv',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '128k',
      '-b:v', '6722k', '-maxrate', '6722k', '-bufsize', '13444k', 'clip-out.mkv'],
  },
  {
    name: 'two-pass stripped',
    instruction: 'convert to mp4',
    duration: 30,
    modelRaw: '-i input.mp4 -c:v libx264 -pass 1 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', 'clip-out.mp4'],
  },
  {
    name: 'mute strips audio flags',
    instruction: 'convert to webm and mute it',
    duration: 30,
    modelRaw: '-i input.mp4 -c:v libvpx-vp9 -an -c:a libopus clip-out.webm',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libvpx-vp9', '-an', 'clip-out.webm'],
  },
  {
    name: 'copy with filter re-encodes',
    instruction: 'convert to mkv, make it 360p',
    duration: 30,
    modelRaw: '-i input.mp4 -vf scale=-2:360 -c:v copy -c:a aac clip-out.mkv',
    expectedArgs: ['-i', '/v/clip.mp4', '-vf', 'scale=-2:360', '-c:v', 'libx264', '-c:a', 'aac', 'clip-out.mkv'],
  },
  {
    name: 'duplicate -vf merged',
    instruction: 'make it 720p and greyscale',
    duration: 30,
    modelRaw: '-i input.mp4 -vf scale=-2:720 -vf hue=s=0 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-vf', 'scale=-2:720,hue=s=0', 'clip-out.mp4'],
  },
  {
    name: 'bare -s shorthand rewritten',
    instruction: 'make it 360p',
    duration: 30,
    modelRaw: '-i input.mp4 -s 360p clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-vf', 'scale=-2:360', 'clip-out.mp4'],
  },
  {
    name: 'missing output appended from codec hint',
    instruction: 'convert to webm',
    duration: 30,
    modelRaw: '-i input.mp4 -c:v libvpx-vp9 -c:a libopus',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libvpx-vp9', '-c:a', 'libopus', 'output.webm'],
  },
  {
    name: 'truncated dangling flag dropped',
    instruction: 'convert to mp4',
    duration: 30,
    modelRaw: '-i input.mp4 -c:v libx264 -movflags',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', 'output.mp4'],
  },
  {
    name: 'first-keep strips -ss, holds -t',
    instruction: 'keep the first 5 seconds',
    duration: 30,
    modelRaw: '-i input.mp4 -ss 3 -t 9 -c:v libx264 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-t', '5', '-c:v', 'libx264', 'clip-out.mp4'],
  },
  {
    name: 'first-remove keeps from N to the end',
    instruction: 'remove the first 5 seconds',
    duration: 30,
    modelRaw: '-i input.mp4 -t 25 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-ss', '5', 'clip-out.mp4'],
  },
  {
    name: 'range normalizes window',
    instruction: 'keep seconds 10 to 20',
    duration: 60,
    modelRaw: '-i input.mp4 -ss 0 -t 5 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-ss', '10', '-t', '10', 'clip-out.mp4'],
  },
  {
    name: 'honeyed request with thanks',
    instruction: 'Hi there honey! Convert to mp4. Thank you!',
    duration: 30,
    modelRaw: 'Of course honey! Here you go:\n-i input.mp4 -c:v libx264 -c:a aac clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', '-c:a', 'aac', 'clip-out.mp4'],
  },
  {
    name: 'speed adds matched audio',
    instruction: 'Speed up 2x',
    duration: 30,
    modelRaw: '-i input.mp4 -vf setpts=0.5*PTS clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-vf', 'setpts=0.5*PTS', '-af', 'atempo=2', 'clip-out.mp4'],
  },
  {
    name: 'speed with copy re-encodes and syncs',
    instruction: 'Speed up 2x',
    duration: 30,
    modelRaw: '-i input.mp4 -c:v copy clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', '-vf', 'setpts=0.5*PTS', '-af', 'atempo=2', 'clip-out.mp4'],
  },
  {
    name: 'fps cap appended',
    instruction: 'Cap it at 30fps',
    duration: 30,
    modelRaw: '-i input.mp4 -c:v libx264 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', '-vf', 'fps=30', 'clip-out.mp4'],
  },
  {
    name: 'width scale appended',
    instruction: 'Make it 640 wide',
    duration: 30,
    modelRaw: '-i input.mp4 -c:v libx264 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', '-vf', 'scale=640:-2', 'clip-out.mp4'],
  },
  {
    name: 'rotation appended',
    instruction: 'Rotate 90 degrees clockwise',
    duration: 30,
    modelRaw: '-i input.mp4 -c:v libx264 clip-out.mp4',
    expectedArgs: ['-i', '/v/clip.mp4', '-c:v', 'libx264', '-vf', 'transpose=1', 'clip-out.mp4'],
  },
];

module.exports = { TRANSLATE_CASES };
