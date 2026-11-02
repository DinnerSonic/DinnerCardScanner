# Art fingerprints: the same math is reimplemented in the scanner's JavaScript.
import numpy as np
from PIL import Image
ART = (0.08, 0.105, 0.92, 0.53)   # art window as fractions of the card (x0, y0, x1, y1)
def grid(img, box, gw, gh, gray=False):
    W, H = img.size
    c = img.crop((round(box[0]*W), round(box[1]*H), round(box[2]*W), round(box[3]*H)))
    c = c.resize((gw*4, gh*4), Image.BILINEAR)                      # same two-step as the browser
    a = np.asarray(c, dtype=np.float32).reshape(gh, 4, gw, 4, 3).mean(axis=(1, 3))
    if gray: a = (a @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
    return a
def norm(a):
    a = a - a.mean(axis=(0, 1), keepdims=True)
    return a / (a.std(axis=(0, 1), keepdims=True) + 8.0)
def fingerprint(img):
    img = img.convert('RGB')
    g  = norm(grid(img, ART, 16, 12, gray=True)).ravel()          # art structure
    ac = norm(grid(img, ART, 6, 4)).ravel()                        # art colour layout
    cc = norm(grid(img, (0, 0, 1, 1), 4, 6)).ravel()               # whole-card colour (frame/type)
    v = np.concatenate([g * 1.0, ac * 0.8, cc * 0.6])
    return (np.clip(v * 32, -127, 127)).astype(np.int8)
