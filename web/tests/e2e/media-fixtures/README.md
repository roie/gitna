# Synthetic media fixtures

These files contain three seconds of blue video or silent audio. They contain no third-party media. FFmpeg 6.1.1 generated them with the commands below. Tests use the committed files, so test runners do not need FFmpeg.

```sh
ffmpeg -f lavfi -i color=c=blue:s=96x64:r=10 -t 3 -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart h264.mp4
ffmpeg -f lavfi -i color=c=blue:s=96x64:r=10 -t 3 -an -c:v libvpx vp8.webm
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 3 -c:a libmp3lame mp3.mp3
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 3 -c:a aac aac.m4a
ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 3 -c:a libopus opus.ogg
```

Tests generate PCM WAV data and valid single-page PDFs directly. Invalid containers and mislabeled HTML are negative fixtures. Valid PDFs exercise native rendering and isolated document scripts.
