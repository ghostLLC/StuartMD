// tauri/src-tauri/src/memory/evolution.rs
//! StuartMD Ebbinghaus Memory Retention Decay & Evolution Engine
//! Implements bounded access gain, immortal pin protection, and Day-0 eviction immunity.

use super::models::OrganicMemoryItem;

/// Base retention stability in days
pub const BASE_STABILITY_DAYS: f64 = 7.0;
/// Minimum retention threshold before pruning candidate
pub const RETENTION_PRUNE_THRESHOLD: f32 = 0.25;
/// Maximum access count saturation bound (prevents unbounded runaway)
pub const MAX_BOUNDED_ACCESS_COUNT: u32 = 50;

/// Computes effective importance score I_eff using bounded Ebbinghaus forgetting curve
pub fn compute_effective_importance(item: &OrganicMemoryItem, now_secs: u64) -> f32 {
    if item.pinned {
        // Pinned memories are immortal and receive bonus multiplier
        return (item.confidence * 2.0).min(2.0);
    }

    let elapsed_secs = now_secs.saturating_sub(item.last_accessed_at);
    let elapsed_days = (elapsed_secs as f64) / 86400.0;

    // Stability S increases with bounded access frequency
    let bounded_access = item.access_count.min(MAX_BOUNDED_ACCESS_COUNT) as f64;
    let stability = BASE_STABILITY_DAYS * (1.0 + bounded_access * 0.2);

    // R(t) = exp(-t / S)
    let retention = (-elapsed_days / stability).exp() as f32;

    item.confidence * retention
}

/// Evaluates whether an organic memory item should be evicted during background pruning.
/// Implements Day-0 immunity: items less than 24 hours old are never evicted regardless of score.
pub fn should_evict_memory(item: &OrganicMemoryItem, now_secs: u64) -> bool {
    // 1. Pinned memories are never evicted
    if item.pinned {
        return false;
    }

    // 2. Day-0 Newborn Immunity: newly created memories are protected for at least 24 hours
    let total_age_secs = now_secs.saturating_sub(item.created_at);
    if total_age_secs < 86400 {
        return false;
    }

    // 3. Evaluate effective importance against retention threshold
    let score = compute_effective_importance(item, now_secs);
    score < RETENTION_PRUNE_THRESHOLD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_day_zero_eviction_immunity() {
        let now = 1000000;
        let newborn = OrganicMemoryItem {
            memory_id: "mem_1".to_string(),
            tier: 1,
            category: "concept".to_string(),
            content: "Brand new insight".to_string(),
            confidence: 0.1, // very low initial confidence
            created_at: now - 3600, // 1 hour old
            last_accessed_at: now - 3600,
            access_count: 1,
            pinned: false,
        };

        // Even with low confidence, Day-0 immunity MUST protect it
        assert!(!should_evict_memory(&newborn, now));
    }

    #[test]
    fn test_pinned_memory_immortality() {
        let now = 10000000;
        let pinned = OrganicMemoryItem {
            memory_id: "mem_2".to_string(),
            tier: 1,
            category: "decision".to_string(),
            content: "Architecture Decision Record".to_string(),
            confidence: 0.2,
            created_at: now - 100 * 86400, // 100 days old
            last_accessed_at: now - 100 * 86400,
            access_count: 1,
            pinned: true,
        };

        assert!(!should_evict_memory(&pinned, now));
        assert!(compute_effective_importance(&pinned, now) >= 0.4);
    }

    #[test]
    fn test_aged_neglected_memory_eviction() {
        let now = 10000000;
        let neglected = OrganicMemoryItem {
            memory_id: "mem_3".to_string(),
            tier: 2,
            category: "glossary".to_string(),
            content: "Unused transient note".to_string(),
            confidence: 0.5,
            created_at: now - 60 * 86400, // 60 days old
            last_accessed_at: now - 60 * 86400,
            access_count: 1,
            pinned: false,
        };

        // 60 days with stability ~8.4 days results in R(t) ~ exp(-7.1) ~ 0.0008, score << 0.25
        assert!(should_evict_memory(&neglected, now));
    }
}
