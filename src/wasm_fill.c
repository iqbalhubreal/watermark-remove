/*
 * Local Watermark Studio: WebAssembly diffusion-fill kernel.
 * No libc, files, network access, or imported functions are required.
 * Pixels outside the selected mask remain unchanged.
 */
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;

#define ORTHOGONAL_WEIGHT 1000u
#define DIAGONAL_WEIGHT 707u
#define BLEND_WEIGHT 550u

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

    if (!passes) {
        passes = count < 25000u ? 8u : count < 120000u ? 5u : count < 350000u ? 3u : 1u;
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
