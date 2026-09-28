#include <iostream>
#include <string>
#include <vector>
#include <sstream>
#include <algorithm>
#include <cctype>

// Escape a string for JSON output
std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size());
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

// Split text into words
std::vector<std::string> tokenize(const std::string& text) {
    std::vector<std::string> words;
    std::istringstream stream(text);
    std::string word;
    while (stream >> word) {
        // Strip leading/trailing punctuation but keep apostrophes inside words
        while (!word.empty() && !std::isalnum((unsigned char)word.front()) && word.front() != '\'')
            word.erase(word.begin());
        while (!word.empty() && !std::isalnum((unsigned char)word.back()) && word.back() != '\'')
            word.pop_back();
        if (!word.empty())
            words.push_back(word);
    }
    return words;
}

int main(int argc, char* argv[]) {
    int chunkSize  = 500;   // words per chunk
    int overlap    = 50;    // words of overlap between chunks

    // Optional args: chunker <chunkSize> <overlap>
    if (argc >= 2) chunkSize = std::atoi(argv[1]);
    if (argc >= 3) overlap   = std::atoi(argv[2]);
    if (chunkSize < 10)  chunkSize = 10;
    if (overlap < 0)     overlap   = 0;
    if (overlap >= chunkSize) overlap = chunkSize / 4;

    // Read all stdin
    std::string text((std::istreambuf_iterator<char>(std::cin)),
                      std::istreambuf_iterator<char>());

    std::vector<std::string> words = tokenize(text);
    int total = (int)words.size();

    std::cout << "[";
    bool first = true;
    int idx = 0;
    int chunkIndex = 0;

    while (idx < total) {
        int end = std::min(idx + chunkSize, total);
        std::string chunk;
        for (int i = idx; i < end; ++i) {
            if (i > idx) chunk += ' ';
            chunk += words[i];
        }
        int wc = end - idx;

        if (!first) std::cout << ",";
        first = false;
        std::cout << "{\"index\":" << chunkIndex
                  << ",\"wordCount\":" << wc
                  << ",\"content\":\"" << jsonEscape(chunk) << "\"}";

        chunkIndex++;
        idx += chunkSize - overlap;
        if (idx <= 0) break;  // safety
    }
    std::cout << "]\n";
    return 0;
}
