"""Bounded alpha conversion for signed SAM 2.1 video-mask scores."""

from __future__ import annotations


def scores_to_alpha(scores, half_width: float = 0.25):
    import numpy as np

    if not 0.05 <= half_width <= 1.0:
        raise ValueError("alpha half-width must be 0.05-1.0")
    values = np.asarray(scores, dtype=np.float32)
    if not np.isfinite(values).all():
        raise ValueError("mask scores must be finite")
    transition = np.clip((values + half_width) / (2 * half_width), 0.0, 1.0)
    # Smoothstep preserves an antialiased contour while producing exact 0/255
    # outside the narrow boundary band. A sigmoid leaves the entire image visible.
    alpha = transition * transition * (3.0 - 2.0 * transition)
    return np.rint(alpha * 255).astype(np.uint8)
