# A stacked collage has one horizontal row where the picture changes completely.
# Downscale to a narrow grey strip, then look for a row-to-row jump far larger
# than the picture's own typical change.
import subprocess, sys, statistics, glob, os
def rows(path, w=48):
    out = subprocess.run(["ffmpeg","-v","error","-i",path,"-vf",f"scale={w}:120,format=gray","-f","rawvideo","-"],
                         capture_output=True).stdout
    return [out[i*w:(i+1)*w] for i in range(len(out)//w)]
for p in sorted(glob.glob(sys.argv[1])):
    r = rows(p)
    if len(r) < 20: continue
    diffs = [sum(abs(a-b) for a,b in zip(r[i], r[i+1]))/len(r[i]) for i in range(len(r)-1)]
    inner = diffs[8:-8]                      # ignore letterbox edges
    med = statistics.median(inner) or 0.01
    peak = max(inner); at = inner.index(peak) + 8
    if peak > 6*med and peak > 12:
        print(f"SEAM  {os.path.basename(p):16} at {at/len(r):.0%} down  (jump {peak:.0f} vs typical {med:.1f})")
