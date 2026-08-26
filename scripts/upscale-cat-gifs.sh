#!/usr/bin/env bash
set -Eeuo pipefail

# Build 360px Retina assets from the credited 月薪喵 GIF pack without
# generative redrawing. 120px sources use edge-aware xBR 3x; the one existing
# 240px source uses a high-quality Lanczos resize. Animation timing and frame
# count are verified before each output is accepted.

CAT_SOURCE_DIR="${1:-}"
CAT_OUTPUT_DIR="${2:-}"

if [[ -z "$CAT_SOURCE_DIR" || -z "$CAT_OUTPUT_DIR" ]]; then
  echo "Usage: scripts/upscale-cat-gifs.sh <source-dir> <output-dir>" >&2
  exit 2
fi

command -v ffmpeg >/dev/null 2>&1 || { echo 'ffmpeg is required.' >&2; exit 1; }
command -v ffprobe >/dev/null 2>&1 || { echo 'ffprobe is required.' >&2; exit 1; }
[[ -d "$CAT_SOURCE_DIR" ]] || { echo "Source directory not found: $CAT_SOURCE_DIR" >&2; exit 1; }

mkdir -p "$CAT_OUTPUT_DIR"
CAT_SOURCE_ABS="$(cd "$CAT_SOURCE_DIR" && pwd)"
CAT_OUTPUT_ABS="$(cd "$CAT_OUTPUT_DIR" && pwd)"
[[ "$CAT_SOURCE_ABS" != "$CAT_OUTPUT_ABS" ]] \
  || { echo 'Source and output directories must be different.' >&2; exit 1; }

shopt -s nullglob
CAT_INPUTS=("$CAT_SOURCE_ABS"/cat-*.gif)
[[ "${#CAT_INPUTS[@]}" -gt 0 ]] || { echo 'No cat-*.gif sources found.' >&2; exit 1; }

for CAT_INPUT in "${CAT_INPUTS[@]}"; do
  CAT_NAME="$(basename "$CAT_INPUT")"
  CAT_WIDTH="$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$CAT_INPUT")"
  CAT_SOURCE_FRAMES="$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$CAT_INPUT")"
  CAT_SOURCE_DURATION="$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$CAT_INPUT")"
  CAT_TEMP="$CAT_OUTPUT_ABS/.$CAT_NAME.tmp.gif"
  CAT_FINAL="$CAT_OUTPUT_ABS/$CAT_NAME"

  if [[ "$CAT_WIDTH" == "120" ]]; then
    CAT_FILTER='[0:v]format=rgba,split=2[color][alpha];[color]xbr=n=3,format=rgba[c];[alpha]alphaextract,format=rgb24,xbr=n=3,format=gray[a];[c][a]alphamerge,format=rgba,split=2[scaled][palette_src];[palette_src]palettegen=stats_mode=diff:reserve_transparent=1:transparency_color=ffffff[palette];[scaled][palette]paletteuse=dither=sierra2_4a:diff_mode=rectangle:alpha_threshold=128[out]'
  else
    CAT_FILTER='[0:v]format=rgba,scale=360:360:flags=lanczos+accurate_rnd,cas=strength=0.15,split=2[scaled][palette_src];[palette_src]palettegen=stats_mode=diff:reserve_transparent=1:transparency_color=ffffff[palette];[scaled][palette]paletteuse=dither=sierra2_4a:diff_mode=rectangle:alpha_threshold=128[out]'
  fi

  ffmpeg -hide_banner -loglevel error -y -i "$CAT_INPUT" \
    -filter_complex "$CAT_FILTER" -map '[out]' -loop 0 "$CAT_TEMP"

  CAT_OUTPUT_SIZE="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$CAT_TEMP")"
  CAT_OUTPUT_FRAMES="$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$CAT_TEMP")"
  CAT_OUTPUT_DURATION="$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$CAT_TEMP")"

  [[ "$CAT_OUTPUT_SIZE" == "360x360" ]] || { echo "$CAT_NAME: unexpected output size $CAT_OUTPUT_SIZE" >&2; exit 1; }
  [[ "$CAT_OUTPUT_FRAMES" == "$CAT_SOURCE_FRAMES" ]] || { echo "$CAT_NAME: frame count changed" >&2; exit 1; }
  [[ "$CAT_OUTPUT_DURATION" == "$CAT_SOURCE_DURATION" ]] || { echo "$CAT_NAME: duration changed" >&2; exit 1; }

  mv "$CAT_TEMP" "$CAT_FINAL"
  printf '%s: %spx -> 360px, %s frames, %ss\n' \
    "$CAT_NAME" "$CAT_WIDTH" "$CAT_OUTPUT_FRAMES" "$CAT_OUTPUT_DURATION"
done
