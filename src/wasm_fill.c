/*
 * Local Watermark Studio: WebAssembly fill kernels.
 * No libc, files, network access, or imported functions are required.
 * Pixels outside the selected mask remain unchanged.
 *
 * Two entry points:
 *   watermark_diffusion_fill  the original smooth diffusion fill.
 *   watermark_texture_fill    the multi-scale patch-based fill (see js/inpaint.js).
 *
 * The texture fill is integer-only and mirrors js/inpaint.js operation for operation, so the
 * JavaScript fallback and this kernel produce identical pixels. Keep the two in sync.
 */
typedef signed char i8;
typedef unsigned char u8;
typedef short i16;
typedef unsigned short u16;
typedef int i32;
typedef unsigned int u32;
typedef unsigned long long u64;

#define ORTHOGONAL_WEIGHT 1000u
#define DIAGONAL_WEIGHT 707u
#define BLEND_WEIGHT 550u

/* ---- shared constants (js/inpaint.js) ---- */
#define MAX_LEVELS 4
#define HOLE_WEIGHT 5u
#define LAMBDA 8u
#define SAMPLE_STRIDE 7u
#define ALPHA_MAX 154u
#define TAU 10u
#define BIAS_MAX 24
#define BIAS_GAIN 16
#define SEED 0x2545F491u

/* ------------------------------------------------------------------------ diffusion */

static void diffuse(u8 *pixels, const u8 *mask, const u16 *distance, const u32 *queue,
                    u8 *scratch, u32 width, u32 height, u32 count, u32 passes) {
    /* The plan queue is ordered from the boundary inward. Estimate every
       selected pixel from all neighbours that are closer to known content. */
    for (u32 q = 0; q < count; ++q) {
        const u32 index = queue[q];
        const u32 x = index % width;
        const u32 y = index / width;
        const u16 d = distance[index];
        u32 red = 0, green = 0, blue = 0, total = 0;

        for (int dy = -1; dy <= 1; ++dy) {
            for (int dx = -1; dx <= 1; ++dx) {
                if (!dx && !dy) continue;
                const int nx = (int)x + dx;
                const int ny = (int)y + dy;
                if (nx < 0 || ny < 0 || nx >= (int)width || ny >= (int)height) continue;
                const u32 ni = (u32)ny * width + (u32)nx;
                if (mask[ni] && distance[ni] >= d) continue;
                const u32 weight = (dx && dy) ? DIAGONAL_WEIGHT : ORTHOGONAL_WEIGHT;
                const u32 p = ni * 4u;
                red += (u32)pixels[p] * weight;
                green += (u32)pixels[p + 1u] * weight;
                blue += (u32)pixels[p + 2u] * weight;
                total += weight;
            }
        }

        if (total) {
            const u32 p = index * 4u;
            pixels[p] = (u8)(red / total);
            pixels[p + 1u] = (u8)(green / total);
            pixels[p + 2u] = (u8)(blue / total);
        }
    }

    /* Relax transitions a few times. Only masked pixels are updated, making
       the workload proportional to the marked watermark rather than the frame. */
    for (u32 pass = 0; pass < passes; ++pass) {
        for (u32 q = 0; q < count; ++q) {
            const u32 index = queue[q];
            const u32 x = index % width;
            const u32 y = index / width;
            u32 red = 0, green = 0, blue = 0, total = 0;

            for (int dy = -1; dy <= 1; ++dy) {
                for (int dx = -1; dx <= 1; ++dx) {
                    if (!dx && !dy) continue;
                    const int nx = (int)x + dx;
                    const int ny = (int)y + dy;
                    if (nx < 0 || ny < 0 || nx >= (int)width || ny >= (int)height) continue;
                    const u32 p = ((u32)ny * width + (u32)nx) * 4u;
                    const u32 weight = (dx && dy) ? DIAGONAL_WEIGHT : ORTHOGONAL_WEIGHT;
                    red += (u32)pixels[p] * weight;
                    green += (u32)pixels[p + 1u] * weight;
                    blue += (u32)pixels[p + 2u] * weight;
                    total += weight;
                }
            }

            const u32 p = index * 4u;
            scratch[p] = total ? (u8)(((u32)pixels[p] * (1000u - BLEND_WEIGHT) + (red / total) * BLEND_WEIGHT) / 1000u) : pixels[p];
            scratch[p + 1u] = total ? (u8)(((u32)pixels[p + 1u] * (1000u - BLEND_WEIGHT) + (green / total) * BLEND_WEIGHT) / 1000u) : pixels[p + 1u];
            scratch[p + 2u] = total ? (u8)(((u32)pixels[p + 2u] * (1000u - BLEND_WEIGHT) + (blue / total) * BLEND_WEIGHT) / 1000u) : pixels[p + 2u];
        }
        for (u32 q = 0; q < count; ++q) {
            const u32 p = queue[q] * 4u;
            pixels[p] = scratch[p];
            pixels[p + 1u] = scratch[p + 1u];
            pixels[p + 2u] = scratch[p + 2u];
        }
    }
}

__attribute__((visibility("default")))
void watermark_diffusion_fill(
    u32 data_offset,
    u32 mask_offset,
    u32 distance_offset,
    u32 queue_offset,
    u32 scratch_offset,
    u32 width,
    u32 height,
    u32 count,
    u32 passes
) {
    u8 *pixels = (u8 *)(unsigned long)data_offset;
    const u8 *mask = (const u8 *)(unsigned long)mask_offset;
    const u16 *distance = (const u16 *)(unsigned long)distance_offset;
    const u32 *queue = (const u32 *)(unsigned long)queue_offset;
    u8 *scratch = (u8 *)(unsigned long)scratch_offset;

    if (!pixels || !mask || !distance || !queue || !scratch || !width || !height || !count) return;

    if (!passes) {
        passes = count < 25000u ? 8u : count < 120000u ? 5u : count < 350000u ? 3u : 1u;
    }
    diffuse(pixels, mask, distance, queue, scratch, width, height, count, passes);
}

/* ------------------------------------------------------------------------ texture fill */

/* Header word indices (u32 array at hdr_offset). Must match js/wasm-kernel.js. */
enum {
    H_LEVELS = 0, H_PASSES, H_IT_FINE, H_IT_COARSE, H_IT_WARM, H_DATA, H_SCRATCH,
    H_STATE_VALID, H_MEAN_COST, H_SAMPLE, H_OUT, H_RESULT,
    H_LEVEL0 = 16, H_LEVEL_STRIDE = 16
};

typedef struct {
    u32 w, h, count, nT, nV, radius;
    const u8 *mask;
    const u16 *distance;
    const u32 *queue;
    const u8 *valid;
    const u32 *targets;
    const u32 *validList;
    u8 *img;
    i32 *nnf;
    u32 *cost;
    i16 *bias;
} Level;

static u32 rnd(u32 *s) {
    u32 x = *s;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *s = x;
    return x;
}

static i32 iabs(i32 v) { return v < 0 ? -v : v; }
static i32 clamp255(i32 v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/* Halve a level image. A coarse pixel is known only when all of its children are known. */
static void downsample(const u8 *src, const Level *sl, u8 *dst, const Level *dl) {
    for (u32 y = 0; y < dl->h; ++y) {
        for (u32 x = 0; x < dl->w; ++x) {
            const u32 di = y * dl->w + x;
            if (dl->mask[di]) continue;
            u32 r = 0, g = 0, b = 0, n = 0;
            for (u32 dy = 0; dy < 2; ++dy) {
                for (u32 dx = 0; dx < 2; ++dx) {
                    const u32 sx = 2 * x + dx, sy = 2 * y + dy;
                    if (sx >= sl->w || sy >= sl->h) continue;
                    const u32 p = (sy * sl->w + sx) * 4u;
                    r += src[p]; g += src[p + 1]; b += src[p + 2]; n++;
                }
            }
            const u32 half = n >> 1;
            dst[di * 4u] = (u8)((r + half) / n);
            dst[di * 4u + 1u] = (u8)((g + half) / n);
            dst[di * 4u + 2u] = (u8)((b + half) / n);
            dst[di * 4u + 3u] = 255;
        }
    }
}

static void upsample_hole(const u8 *coarse, const Level *cl, u8 *fine, const Level *fl) {
    for (u32 q = 0; q < fl->count; ++q) {
        const u32 i = fl->queue[q], x = i % fl->w, y = i / fl->w;
        const u32 c = ((y >> 1) * cl->w + (x >> 1)) * 4u, p = i * 4u;
        fine[p] = coarse[c]; fine[p + 1] = coarse[c + 1]; fine[p + 2] = coarse[c + 2];
    }
}

static u32 patch_dist(const Level *lv, const u8 *d, i32 tx, i32 ty, i32 sx, i32 sy, u32 limit) {
    const i32 r = (i32)lv->radius, w = (i32)lv->w, h = (i32)lv->h;
    u32 sum = 0;
    for (i32 dy = -r; dy <= r; ++dy) {
        i32 ty2 = ty + dy; if (ty2 < 0) ty2 = 0; else if (ty2 >= h) ty2 = h - 1;
        const i32 tRow = ty2 * w, sRow = (sy + dy) * w;
        for (i32 dx = -r; dx <= r; ++dx) {
            i32 tx2 = tx + dx; if (tx2 < 0) tx2 = 0; else if (tx2 >= w) tx2 = w - 1;
            const i32 ti = tRow + tx2;
            const i32 p = ti * 4, q = (sRow + sx + dx) * 4;
            const i32 e0 = (i32)d[p] - (i32)d[q];
            const i32 e1 = (i32)d[p + 1] - (i32)d[q + 1];
            const i32 e2 = (i32)d[p + 2] - (i32)d[q + 2];
            sum += (lv->mask[ti] ? HOLE_WEIGHT : 16u) * (u32)(e0 * e0 + e1 * e1 + e2 * e2);
        }
        if (sum >= limit) return sum;
    }
    return sum;
}

static void try_candidate(const Level *lv, const u8 *d, u32 ti, i32 tx, i32 ty, i32 sx, i32 sy) {
    const i32 w = (i32)lv->w, h = (i32)lv->h;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
    const u32 si = (u32)(sy * w + sx);
    if (!lv->valid[si]) return;
    const u32 pen = (u32)(iabs(sx - tx) + iabs(sy - ty)) * LAMBDA * 16u;
    const u32 limit = lv->cost[ti];
    if (pen >= limit) return;
    const u32 dd = patch_dist(lv, d, tx, ty, sx, sy, limit - pen) + pen;
    if (dd < limit) { lv->cost[ti] = dd; lv->nnf[ti] = (i32)si; }
}

static void vote(const Level *lv, u8 *d) {
    const i32 r = (i32)lv->radius, w = (i32)lv->w, h = (i32)lv->h;
    /* Colour offset between each target patch and the source patch it copies. */
    for (u32 k = 0; k < lv->nT; ++k) {
        const u32 ti = lv->targets[k];
        const i32 tx = (i32)(ti % lv->w), ty = (i32)(ti / lv->w);
        const i32 si = lv->nnf[ti], sx = si % w, sy = si / w;
        i32 b0 = 0, b1 = 0, b2 = 0, bw = 0;
        for (i32 dy = -r; dy <= r; ++dy) {
            i32 ty2 = ty + dy; if (ty2 < 0) ty2 = 0; else if (ty2 >= h) ty2 = h - 1;
            const i32 tRow = ty2 * w, sRow = (sy + dy) * w;
            for (i32 dx = -r; dx <= r; ++dx) {
                i32 tx2 = tx + dx; if (tx2 < 0) tx2 = 0; else if (tx2 >= w) tx2 = w - 1;
                const i32 tj = tRow + tx2, p = tj * 4, q = (sRow + sx + dx) * 4;
                const i32 wt = lv->mask[tj] ? (i32)HOLE_WEIGHT : 16;
                b0 += wt * ((i32)d[p] - (i32)d[q]);
                b1 += wt * ((i32)d[p + 1] - (i32)d[q + 1]);
                b2 += wt * ((i32)d[p + 2] - (i32)d[q + 2]);
                bw += wt;
            }
        }
        i32 c0 = b0 / bw, c1 = b1 / bw, c2 = b2 / bw;
        c0 = (c0 < -BIAS_MAX ? -BIAS_MAX : c0 > BIAS_MAX ? BIAS_MAX : c0) * BIAS_GAIN / 16;
        c1 = (c1 < -BIAS_MAX ? -BIAS_MAX : c1 > BIAS_MAX ? BIAS_MAX : c1) * BIAS_GAIN / 16;
        c2 = (c2 < -BIAS_MAX ? -BIAS_MAX : c2 > BIAS_MAX ? BIAS_MAX : c2) * BIAS_GAIN / 16;
        lv->bias[ti * 3u] = (i16)c0; lv->bias[ti * 3u + 1u] = (i16)c1; lv->bias[ti * 3u + 2u] = (i16)c2;
    }
    for (u32 q = 0; q < lv->count; ++q) {
        const u32 zi = lv->queue[q];
        const i32 zx = (i32)(zi % lv->w), zy = (i32)(zi / lv->w);
        i32 sr = 0, sg = 0, sb = 0, sw = 0;
        for (i32 dy = -r; dy <= r; ++dy) {
            const i32 ty = zy + dy; if (ty < 0 || ty >= h) continue;
            for (i32 dx = -r; dx <= r; ++dx) {
                const i32 tx = zx + dx; if (tx < 0 || tx >= w) continue;
                const i32 ti = ty * w + tx, si = lv->nnf[ti];
                if (si < 0) continue;
                const i32 sx = (si % w) - dx, sy = (si / w) - dy;
                const i32 tri = (r + 1 - iabs(dx)) * (r + 1 - iabs(dy));
                const i32 wt = tri * tri, p = (sy * w + sx) * 4, bi = ti * 3;
                sr += ((i32)d[p] + lv->bias[bi]) * wt;
                sg += ((i32)d[p + 1] + lv->bias[bi + 1]) * wt;
                sb += ((i32)d[p + 2] + lv->bias[bi + 2]) * wt;
                sw += wt;
            }
        }
        if (sw) {
            const u32 p = zi * 4u;
            const i32 half = sw >> 1;
            d[p] = (u8)clamp255((sr + half) / sw);
            d[p + 1] = (u8)clamp255((sg + half) / sw);
            d[p + 2] = (u8)clamp255((sb + half) / sw);
        }
    }
}

/* One cold or warm pass of the multi-scale fill; returns the finest level's mean patch cost. */
static u32 run_texture(u8 *data, Level *levels, u32 L, u32 passes, u32 it_fine, u32 it_coarse,
                       u32 it_warm, u8 *scratch, int warm) {
    u32 rng = SEED;
    u8 *imgs[MAX_LEVELS];
    imgs[0] = data;
    for (u32 l = 1; l < L; ++l) imgs[l] = levels[l].img;
    if (!warm) {
        for (u32 l = 1; l < L; ++l) downsample(imgs[l - 1], &levels[l - 1], imgs[l], &levels[l]);
        const Level *c = &levels[L - 1];
        diffuse(imgs[L - 1], c->mask, c->distance, c->queue, scratch, c->w, c->h, c->count, passes);
    }

    const i32 *prevNnf = 0;
    i32 prevW = 0, prevH = 0;
    u32 meanCost = 0;
    for (i32 l = warm ? 0 : (i32)L - 1; l >= 0; --l) {
        Level *lv = &levels[l];
        u8 *d = imgs[l];
        const i32 w = (i32)lv->w, h = (i32)lv->h;
        const u32 nT = lv->nT, nV = lv->nV;

        const int haveCoarse = prevNnf != 0;
        if (haveCoarse) upsample_hole(imgs[l + 1], &levels[l + 1], d, lv);
        for (u32 k = 0; k < nT; ++k) {
            const u32 ti = lv->targets[k];
            const i32 tx = (i32)(ti % lv->w), ty = (i32)(ti / lv->w);
            int done = 0;
            if (warm) {
                done = lv->nnf[ti] >= 0;
            } else {
                lv->cost[ti] = 0xFFFFFFFFu;
                lv->nnf[ti] = -1;
                if (haveCoarse) {
                    const i32 px = tx >> 1, py = ty >> 1;
                    const i32 ps = (px < prevW && py < prevH) ? prevNnf[py * prevW + px] : -1;
                    if (ps >= 0) {
                        const i32 sx = 2 * (ps % prevW) + (tx & 1), sy = 2 * (ps / prevW) + (ty & 1);
                        if (sx < w && sy < h && lv->valid[sy * w + sx]) { lv->nnf[ti] = sy * w + sx; done = 1; }
                    }
                }
            }
            if (!done) {
                lv->nnf[ti] = -1; lv->cost[ti] = 0xFFFFFFFFu;
                for (int n = 0; n < 8; ++n) {
                    const i32 ox = (i32)(rnd(&rng) % 49u) - 24, oy = (i32)(rnd(&rng) % 49u) - 24;
                    try_candidate(lv, d, ti, tx, ty, tx + ox, ty + oy);
                }
                if (lv->nnf[ti] < 0) {
                    for (int n = 0; n < 6; ++n) {
                        const u32 si = lv->validList[rnd(&rng) % nV];
                        try_candidate(lv, d, ti, tx, ty, (i32)(si % lv->w), (i32)(si / lv->w));
                    }
                }
                if (lv->nnf[ti] < 0) lv->nnf[ti] = (i32)lv->validList[0];
            }
        }
        if (haveCoarse || warm) vote(lv, d);
        for (u32 k = 0; k < nT; ++k) {
            const u32 ti = lv->targets[k];
            const i32 tx = (i32)(ti % lv->w), ty = (i32)(ti / lv->w);
            const i32 si = lv->nnf[ti], sx = si % w, sy = si / w;
            lv->cost[ti] = patch_dist(lv, d, tx, ty, sx, sy, 0xFFFFFFFFu) + (u32)(iabs(sx - tx) + iabs(sy - ty)) * LAMBDA * 16u;
        }

        const i32 half = (w > h ? w : h) >> 1;
        const i32 maxR = half < 64 ? half : 64;
        const u32 iters = l == 0 ? (warm ? it_warm : it_fine) : it_coarse;
        for (u32 it = 0; it < iters; ++it) {
            const int fwd = (it & 1u) == 0;
            for (u32 k = 0; k < nT; ++k) {
                const u32 ti = lv->targets[fwd ? k : nT - 1u - k];
                const i32 tx = (i32)(ti % lv->w), ty = (i32)(ti / lv->w), step = fwd ? 1 : -1;
                const u32 n1 = fwd ? ti - 1u : ti + 1u, n2 = fwd ? ti - lv->w : ti + lv->w;
                if (((fwd && tx > 0) || (!fwd && tx < w - 1)) && lv->nnf[n1] >= 0) {
                    const i32 si = lv->nnf[n1];
                    try_candidate(lv, d, ti, tx, ty, (si % w) + step, si / w);
                }
                if (((fwd && ty > 0) || (!fwd && ty < h - 1)) && lv->nnf[n2] >= 0) {
                    const i32 si = lv->nnf[n2];
                    try_candidate(lv, d, ti, tx, ty, si % w, (si / w) + step);
                }
                const i32 bi = lv->nnf[ti], bx = bi % w, by = bi / w;
                for (i32 R = maxR; R >= 1; R >>= 1) {
                    const i32 ox = (i32)(rnd(&rng) % (u32)(2 * R + 1)) - R, oy = (i32)(rnd(&rng) % (u32)(2 * R + 1)) - R;
                    try_candidate(lv, d, ti, tx, ty, bx + ox, by + oy);
                }
            }
            vote(lv, d);
        }
        if (l > 0) {
            prevNnf = lv->nnf; prevW = w; prevH = h;
        } else {
            u64 total = 0;
            for (u32 k = 0; k < nT; ++k) total += lv->cost[lv->targets[k]];
            meanCost = (u32)(total / nT);
        }
    }
    return meanCost;
}

__attribute__((visibility("default")))
void watermark_texture_fill(u32 hdr_offset) {
    u32 *hdr = (u32 *)(unsigned long)hdr_offset;
    if (!hdr) return;
    hdr[H_RESULT] = 0;
    const u32 L = hdr[H_LEVELS];
    if (!L || L > MAX_LEVELS) return;

    Level levels[MAX_LEVELS];
    for (u32 l = 0; l < L; ++l) {
        const u32 *e = hdr + H_LEVEL0 + l * H_LEVEL_STRIDE;
        Level *lv = &levels[l];
        lv->w = e[0]; lv->h = e[1]; lv->count = e[2]; lv->nT = e[3]; lv->nV = e[4]; lv->radius = e[5];
        lv->mask = (const u8 *)(unsigned long)e[6];
        lv->distance = (const u16 *)(unsigned long)e[7];
        lv->queue = (const u32 *)(unsigned long)e[8];
        lv->valid = (const u8 *)(unsigned long)e[9];
        lv->targets = (const u32 *)(unsigned long)e[10];
        lv->validList = (const u32 *)(unsigned long)e[11];
        lv->img = (u8 *)(unsigned long)e[12];
        lv->nnf = (i32 *)(unsigned long)e[13];
        lv->cost = (u32 *)(unsigned long)e[14];
        lv->bias = (i16 *)(unsigned long)e[15];
    }
    u8 *data = (u8 *)(unsigned long)hdr[H_DATA];
    u8 *scratch = (u8 *)(unsigned long)hdr[H_SCRATCH];
    u8 *sample = (u8 *)(unsigned long)hdr[H_SAMPLE];
    u8 *out = (u8 *)(unsigned long)hdr[H_OUT];
    const Level *l0 = &levels[0];
    levels[0].img = data;
    const u32 passes = hdr[H_PASSES], it_fine = hdr[H_IT_FINE], it_coarse = hdr[H_IT_COARSE], it_warm = hdr[H_IT_WARM];
    const u32 w0 = l0->w, h0 = l0->h, area = w0 * h0;

    /* Known pixels sampled from this frame, to tell whether the scene is steady. */
    const u32 sampleCount = (area + SAMPLE_STRIDE - 1u) / SAMPLE_STRIDE;
    /* The previous sample is kept in the state region, so compute this one in the tail of it. */
    u8 *cur = sample + sampleCount * 3u;
    for (u32 i = 0, k = 0; i < area; i += SAMPLE_STRIDE, ++k) {
        if (l0->mask[i]) { cur[k * 3u] = 0; cur[k * 3u + 1u] = 0; cur[k * 3u + 2u] = 0; continue; }
        const u32 p = i * 4u;
        cur[k * 3u] = data[p]; cur[k * 3u + 1u] = data[p + 1u]; cur[k * 3u + 2u] = data[p + 2u];
    }

    int warm = hdr[H_STATE_VALID] != 0;
    /* A warm start continues from the previous frame's clean fill, never from this frame's raw hole
       pixels (they still contain the watermark, and would leak into the colour matching). */
    if (warm) {
        for (u32 q = 0; q < l0->count; ++q) {
            const u32 p = l0->queue[q] * 4u;
            data[p] = out[q * 3u]; data[p + 1u] = out[q * 3u + 1u]; data[p + 2u] = out[q * 3u + 2u];
        }
    }
    u32 meanCost = run_texture(data, levels, L, passes, it_fine, it_coarse, it_warm, scratch, warm);
    /* A big jump in matching cost means a scene cut or a seek: start over from scratch. */
    if (warm) {
        const u64 rr = 2u * l0->radius + 1u;
        if ((u64)meanCost * 2u > (u64)hdr[H_MEAN_COST] * 5u + 2u * 16u * rr * rr * 30u) {
            warm = 0;
            meanCost = run_texture(data, levels, L, passes, it_fine, it_coarse, it_warm, scratch, 0);
        }
    }

    /* Blend with the previous frame's fill while the surroundings hardly changed. */
    u32 alpha = 0;
    if (warm) {
        u64 sum = 0, n = 0;
        for (u32 i = 0, k = 0; i < area; i += SAMPLE_STRIDE, ++k) {
            if (l0->mask[i]) continue;
            const u32 b = k * 3u;
            sum += (u64)iabs((i32)cur[b] - (i32)sample[b]) + (u64)iabs((i32)cur[b + 1u] - (i32)sample[b + 1u]) + (u64)iabs((i32)cur[b + 2u] - (i32)sample[b + 2u]);
            n += 3;
        }
        if (n && sum < (u64)TAU * n) alpha = (u32)((u64)ALPHA_MAX * ((u64)TAU * n - sum) / ((u64)TAU * n));
    }
    for (u32 q = 0; q < l0->count; ++q) {
        const u32 p = l0->queue[q] * 4u;
        if (alpha > 0) {
            for (u32 c = 0; c < 3; ++c) data[p + c] = (u8)(((u32)data[p + c] * (256u - alpha) + (u32)out[q * 3u + c] * alpha + 128u) >> 8);
        }
        out[q * 3u] = data[p]; out[q * 3u + 1u] = data[p + 1u]; out[q * 3u + 2u] = data[p + 2u];
    }
    for (u32 i = 0; i < sampleCount * 3u; ++i) sample[i] = cur[i];
    hdr[H_MEAN_COST] = meanCost;
    hdr[H_STATE_VALID] = 1;
    hdr[H_RESULT] = 1;
}
