// NeuralTrade C++ Expert System Layer
//
// Reads concatenated knowledge text from stdin, scans it for ICT/SMC concepts,
// extracts a weighted concept set + heuristic trading rules, then emits a
// single synthesized mega-strategy as JSON on stdout.
//
// Usage: expert-system <sourcesUsed> < knowledge.txt
//
// Build: g++ -std=c++17 -O2 -static -o expert-system expert_system.cpp

#include <iostream>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <algorithm>
#include <cctype>
#include <cstring>

// ── JSON helpers ────────────────────────────────────────────────────────────

static std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

static std::string toLower(const std::string& s) {
    std::string out(s);
    std::transform(out.begin(), out.end(), out.begin(),
                   [](unsigned char c){ return std::tolower(c); });
    return out;
}

// ── Concept dictionary ──────────────────────────────────────────────────────
// Each concept has: canonical name, definition, list of keyword aliases.
// The expert system scans the (lowercased) text once and counts hits per
// concept across ALL its aliases. Aliases are matched as substrings.

struct Concept {
    std::string name;
    std::string definition;
    std::vector<std::string> keywords;
};

static std::vector<Concept> conceptDictionary() {
    return {
        { "Liquidity Sweep",
          "Price runs above a swing high or below a swing low to take out resting stop orders before reversing.",
          { "liquidity sweep", "stop hunt", "stop run", "liquidity grab", "raid", "buyside liquidity",
            "sellside liquidity", "bsl", "ssl", "sweep the highs", "sweep the lows" } },

        { "Order Block",
          "The last opposing candle before an impulsive move; institutional accumulation/distribution zone used as a re-entry.",
          { "order block", "ob ", "bullish ob", "bearish ob", "mitigation block",
            "breaker block", "institutional candle", "last down candle", "last up candle" } },

        { "Fair Value Gap",
          "A 3-candle imbalance where the wicks of candle 1 and candle 3 do not overlap, leaving an inefficiency that price tends to revisit.",
          { "fair value gap", "fvg", "imbalance", "inefficiency", "price gap", "liquidity void", "balanced price range" } },

        { "Break of Structure",
          "A confirmed close beyond a prior swing point in the trend direction, signalling continuation.",
          { "break of structure", "bos ", "structure break", "market structure shift", "mss",
            "higher high", "lower low", "trend continuation" } },

        { "Change of Character",
          "The first counter-trend break of structure that hints at a possible trend reversal.",
          { "change of character", "choch", "ch och", "reversal of structure",
            "first higher high", "first lower low" } },

        { "Inducement",
          "A minor liquidity pool engineered to trap early traders before the real move from a deeper point of interest.",
          { "inducement", "idm", "trap move", "false break", "liquidity trap", "engineered liquidity" } },

        { "Kill Zone",
          "High-probability time windows (London open, New York open, Asian range) when institutional flow is strongest.",
          { "kill zone", "killzone", "london open", "new york open", "ny open", "asian range",
            "london session", "new york session", "ny session", "ict killzone", "silver bullet" } },

        { "Premium / Discount",
          "Price split across the dealing range: discount (lower 50%) for longs, premium (upper 50%) for shorts.",
          { "premium", "discount", "equilibrium", "fibonacci 50", "dealing range",
            "optimal trade entry", "ote", "0.62 retracement", "0.705 retracement" } },

        { "Power of Three",
          "Accumulation → Manipulation → Distribution: the three phases of how institutions deliver price each session.",
          { "power of three", "po3", "accumulation manipulation distribution", "amd",
            "judas swing", "manipulation phase", "distribution phase" } },

        { "Smart Money Concepts",
          "Umbrella framework reading price as institutional footprints rather than retail indicators.",
          { "smart money", "smc", "institutional", "smart money concept", "smart money concepts",
            "institutional order flow", "institutional trading" } },

        { "Risk Management",
          "Position sizing, stop placement and risk:reward filters that protect capital across the strategy.",
          { "risk management", "position size", "risk reward", "risk:reward", "rr ratio",
            "stop loss", "1% risk", "2% risk", "drawdown", "money management" } },

        { "Market Structure",
          "The ladder of swing highs and lows that defines whether price is in a bullish, bearish, or ranging state.",
          { "market structure", "swing high", "swing low", "internal structure",
            "external structure", "trend structure", "structural levels" } },
    };
}

// ── Sentence extraction (for evidence snippets) ─────────────────────────────

static std::vector<std::string> splitSentences(const std::string& text) {
    std::vector<std::string> out;
    std::string cur;
    for (char c : text) {
        cur += c;
        if (c == '.' || c == '!' || c == '?' || c == '\n') {
            // strip leading whitespace
            size_t i = 0;
            while (i < cur.size() && std::isspace((unsigned char)cur[i])) ++i;
            std::string trimmed = cur.substr(i);
            if (trimmed.size() >= 30 && trimmed.size() <= 280) {
                out.push_back(trimmed);
            }
            cur.clear();
        }
    }
    return out;
}

// ── Heuristic rule synthesis ────────────────────────────────────────────────
// Given which concepts fired, build a small set of execution rules in
// priority order. Rules are derived from concept combinations the system
// recognises as canonical ICT setups.

struct Rule {
    std::string id;
    std::string title;
    std::string trigger;
    std::string entry;
    std::string stop;
    std::string target;
    int priority;
};

static std::vector<Rule> synthesizeRules(const std::map<std::string, int>& hits) {
    auto has = [&](const std::string& n) { return hits.count(n) && hits.at(n) > 0; };
    std::vector<Rule> rules;

    if (has("Liquidity Sweep") && has("Order Block")) {
        rules.push_back({
            "rule_sweep_ob",
            "Sweep + Order Block reversal",
            "Liquidity is taken above/below a recent swing AND price returns into a prior order block",
            "Limit order at the order block edge after the sweep wick prints",
            "Just beyond the swept liquidity wick (structural invalidation)",
            "Opposite-side liquidity pool (buyside or sellside)",
            10
        });
    }
    if (has("Fair Value Gap") && (has("Break of Structure") || has("Change of Character"))) {
        rules.push_back({
            "rule_fvg_bos",
            "FVG retrace after BOS / CHoCH",
            "Structure shifts, then price retraces into the unfilled fair value gap that caused it",
            "Inside the FVG, ideally at the consequent encroachment (50% of the gap)",
            "Beyond the FVG away from the entry",
            "Next external liquidity pool aligned with the new trend",
            9
        });
    }
    if (has("Inducement") && has("Order Block")) {
        rules.push_back({
            "rule_inducement",
            "Inducement-protected Order Block",
            "An inducement liquidity pool sits between price and a deeper order block; wait for inducement to be taken",
            "Order block tap after the inducement is swept",
            "Beyond the order block",
            "Opposing draw on liquidity",
            8
        });
    }
    if (has("Premium / Discount")) {
        rules.push_back({
            "rule_pd_array",
            "Premium / Discount filter",
            "Only take longs from the discount half of the current dealing range, only take shorts from the premium half",
            "Confluence with order block or FVG inside the correct half",
            "Outside the dealing range",
            "Equilibrium first, then opposite extreme",
            7
        });
    }
    if (has("Kill Zone")) {
        rules.push_back({
            "rule_killzone",
            "Time-of-day filter",
            "Only trade during London Open, New York Open or Silver Bullet kill zone windows",
            "Standard entry rules apply, but only during the kill zone",
            "Standard structural stop",
            "Standard liquidity-based target",
            6
        });
    }
    if (has("Power of Three")) {
        rules.push_back({
            "rule_po3",
            "Daily Power of Three",
            "Identify accumulation range, wait for manipulation (Judas swing) against the expected daily bias",
            "On reversal back through the open after manipulation completes",
            "Beyond the manipulation extreme",
            "Daily expansion target in the bias direction",
            5
        });
    }
    if (has("Risk Management")) {
        rules.push_back({
            "rule_risk",
            "Risk envelope",
            "Risk no more than 1% of equity per setup; require minimum 1:3 risk-to-reward",
            "Entry is only valid when sizing constraints are met",
            "Hard stop at structural invalidation",
            "Target must give at least 3R or it is skipped",
            4
        });
    }

    // Always include a fallback if nothing matched, so the strategy is never empty.
    if (rules.empty()) {
        rules.push_back({
            "rule_default",
            "Generic structural setup",
            "Wait for a confirmed shift in market structure on the trading timeframe",
            "Pullback into the most recent point of interest",
            "Beyond the originating swing",
            "Next external liquidity pool",
            1
        });
    }

    std::sort(rules.begin(), rules.end(),
              [](const Rule& a, const Rule& b){ return a.priority > b.priority; });
    return rules;
}

// ── Main ────────────────────────────────────────────────────────────────────

int main(int argc, char** argv) {
    int sourcesUsed = 0;
    if (argc > 1) sourcesUsed = std::atoi(argv[1]);

    // Slurp stdin
    std::ostringstream ss;
    ss << std::cin.rdbuf();
    const std::string raw = ss.str();
    const std::string lower = toLower(raw);
    const auto sentences = splitSentences(raw);

    // Scan concepts
    auto dict = conceptDictionary();
    std::map<std::string, int> hits;            // concept name -> hit count
    std::map<std::string, std::string> evidence; // concept name -> first matching sentence

    long long totalHits = 0;
    for (const auto& c : dict) {
        int count = 0;
        std::string firstHitKw;
        for (const auto& kw : c.keywords) {
            if (kw.empty()) continue;
            size_t pos = 0;
            while ((pos = lower.find(kw, pos)) != std::string::npos) {
                ++count;
                if (firstHitKw.empty()) firstHitKw = kw;
                pos += kw.size();
            }
        }
        hits[c.name] = count;
        totalHits += count;

        // Find an evidence sentence containing one of the keywords
        if (count > 0) {
            for (const auto& kw : c.keywords) {
                bool found = false;
                for (const auto& sent : sentences) {
                    if (toLower(sent).find(kw) != std::string::npos) {
                        evidence[c.name] = sent;
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }
        }
    }

    // Build active concept list (only those with hits), sorted by frequency desc
    struct ActiveConcept {
        std::string name;
        std::string definition;
        int hitCount;
        double weight;
        std::string evidence;
    };
    std::vector<ActiveConcept> active;
    for (const auto& c : dict) {
        int h = hits[c.name];
        if (h <= 0) continue;
        double w = totalHits > 0 ? (double)h / (double)totalHits : 0.0;
        active.push_back({ c.name, c.definition, h, w, evidence[c.name] });
    }
    std::sort(active.begin(), active.end(),
              [](const ActiveConcept& a, const ActiveConcept& b){ return a.hitCount > b.hitCount; });

    // Synthesize rules
    auto rules = synthesizeRules(hits);

    // Build summary string
    std::ostringstream summary;
    if (active.empty()) {
        summary << "No ICT/SMC concepts were detected in the supplied knowledge. "
                << "Add at least one ICT-focused source (book, video transcript or notes) "
                << "for the expert system to derive a strategy.";
    } else {
        summary << "Synthesized from " << sourcesUsed
                << " knowledge source" << (sourcesUsed == 1 ? "" : "s")
                << ", with " << active.size() << " ICT concept"
                << (active.size() == 1 ? "" : "s") << " detected. ";
        summary << "Top-weighted: " << active.front().name;
        if (active.size() > 1) summary << " and " << (active.size() - 1) << " more";
        summary << ". " << rules.size() << " execution rule"
                << (rules.size() == 1 ? "" : "s") << " derived.";
    }

    // Word count for transparency
    long long wordCount = 0;
    {
        std::istringstream wstream(raw);
        std::string w;
        while (wstream >> w) ++wordCount;
    }

    // ── Emit JSON ───────────────────────────────────────────────────────────
    std::ostringstream out;
    out << "{";
    out << "\"name\":\"NeuralTrade Synthesized Mega-Strategy\",";
    out << "\"type\":\"mega\",";
    out << "\"sourcesUsed\":" << sourcesUsed << ",";
    out << "\"wordsAnalyzed\":" << wordCount << ",";
    out << "\"totalHits\":" << totalHits << ",";
    out << "\"summary\":\"" << jsonEscape(summary.str()) << "\",";

    // concepts
    out << "\"concepts\":[";
    for (size_t i = 0; i < active.size(); ++i) {
        const auto& a = active[i];
        if (i) out << ",";
        out << "{";
        out << "\"name\":\"" << jsonEscape(a.name) << "\",";
        out << "\"definition\":\"" << jsonEscape(a.definition) << "\",";
        out << "\"hitCount\":" << a.hitCount << ",";
        // weight as fixed-point string
        char wbuf[32];
        snprintf(wbuf, sizeof(wbuf), "%.4f", a.weight);
        out << "\"weight\":" << wbuf << ",";
        out << "\"evidence\":\"" << jsonEscape(a.evidence) << "\"";
        out << "}";
    }
    out << "],";

    // rules
    out << "\"rules\":[";
    for (size_t i = 0; i < rules.size(); ++i) {
        const auto& r = rules[i];
        if (i) out << ",";
        out << "{";
        out << "\"id\":\""       << jsonEscape(r.id)       << "\",";
        out << "\"title\":\""    << jsonEscape(r.title)    << "\",";
        out << "\"trigger\":\""  << jsonEscape(r.trigger)  << "\",";
        out << "\"entry\":\""    << jsonEscape(r.entry)    << "\",";
        out << "\"stop\":\""     << jsonEscape(r.stop)     << "\",";
        out << "\"target\":\""   << jsonEscape(r.target)   << "\",";
        out << "\"priority\":"   << r.priority;
        out << "}";
    }
    out << "]";
    out << "}";

    std::cout << out.str() << std::endl;
    return 0;
}
