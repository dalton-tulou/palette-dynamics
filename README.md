# Palette Dynamics

A browser tool that reorders the palette of an indexed image so the picture
still looks right when the **most significant bits** of each pixel index are
dropped (on an Amiga: when the top bitplanes are switched off).

```bash
npm install
npm run dev     # open http://localhost:5173
npm test
```

Drop an indexed PNG (1/2/4/8-bit, Adam7 ok), a GIF (first frame) or an IFF
ILBM/PBM (ByteRun1, EHB) onto the page. True-color images (RGB/RGBA/16-bit
PNG, HAM6/HAM8 and 24/32-bit ILBM, or anything the browser can decode such as
JPEG/WebP) are converted: with 256 colors or fewer they become the palette
as-is, otherwise they are reduced to 256 colors (median cut + k-means in
OKLab) with Floyd–Steinberg dithering. Transparent pixels get one palette entry. **Rearrange colors** finds a
new order, the **bit depth** slider shows the image with only the lowest *n*
bits kept, and you can export the result as PNG or ILBM.

## Deployment

Every push to `main` runs the tests, builds, and publishes `dist/` to GitHub
Pages (`.github/workflows/deploy.yml`). One-time setup in the GitHub repo:
**Settings → Pages → Build and deployment → Source: GitHub Actions**.

## How it works

With *n* bits kept, index *i* displays `palette[i mod 2^n]`, so the palette is
a binary tree: slot *j* stands in for slots *j + m·2^n*. The rearranger
(`src/rearrange.ts`):

1. puts the weighted medoid colour (by pixel count, OKLab distance) at slot 0;
2. for each depth, splits every class into two equal halves, keeping the
   existing representative and picking the new one that minimises error;
3. refines with pairwise slot swaps, minimising the summed error over all
   depths (each normalised so every depth counts equally).

Only the order changes; the colours themselves stay the same.
