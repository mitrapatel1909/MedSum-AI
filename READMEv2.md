# 🧬 MedSumAI

**AI-powered biomedical research summarizer — making scientific literature accessible to everyone.**

---

## 🔍 What is MedSumAI?

MedSumAI is an automated research tool that takes any medical or biomedical topic, searches PubMed (the world's largest database of scientific articles), and generates a clear, easy-to-understand summary — complete with citations and direct links to the original articles.

No medical degree required. Just type a topic and get answers.

---

## 🌍 Why I Built This

Every year, millions of scientific articles are published on PubMed. But most people — students, patients, caregivers, and even researchers outside a specific field — can't easily access or understand them. The language is technical, the search process is tedious, and making sense of multiple papers at once is time-consuming.

**MedSumAI solves this.** It bridges the gap between cutting-edge medical research and the people who need it most, by automatically finding relevant articles and translating them into plain language.

This tool was built to help:
- 🎓 **Students** researching topics for science classes or competitions
- 🔬 **Researchers** who need a fast overview of a new topic
- 🏥 **Patients and caregivers** trying to understand a diagnosis or treatment
- 📰 **Anyone** curious about the latest in medical science

---

## ⚙️ How It Works

MedSumAI is built as an automated workflow using **n8n**, a powerful open-source automation platform. Here's the step-by-step flow:

```
User types a topic
       ↓
Search PubMed for relevant article IDs
       ↓
Fetch full article details from PubMed API
       ↓
Extract abstracts, titles, authors & links
       ↓
Send all articles to GPT-4o-mini for summarization
       ↓
Output a clear summary with citations in HTML/Markdown
```

### Workflow Nodes
| Step | Tool | Purpose |
|------|------|---------|
| 1 | Edit Fields | User inputs their research topic |
| 2 | HTTP Request | Search PubMed for matching article IDs |
| 3 | HTTP Request | Fetch article details from PubMed |
| 4 | HTTP Request | Fetch full article data (abstracts, metadata) |
| 5 | XML to JSON | Parse PubMed's XML response |
| 6 | Code (JavaScript) | Extract title, authors, abstract, PMID & build links |
| 7 | GPT-4o-mini | Generate a plain-language summary with references |
| 8 | Markdown to HTML | Format the final output |

---

## 🌐 Live Demo

👉 **[Try MedSumAI Live](https://mitrapatel1909.github.io/MedSumAI)**

---

## 🚀 Features

- 🔎 **Live PubMed search** — always pulls the most recent articles
- 🤖 **AI-generated summaries** — powered by GPT-4o-mini
- 📚 **Full citations** — every summary includes article titles, authors, and direct PubMed links
- 🗣️ **Plain language output** — written for non-experts
- ⚡ **Fast** — results in seconds

---

## 🛠️ Tech Stack

- **n8n** — workflow automation
- **PubMed E-utilities API** — free, open access to biomedical literature
- **OpenAI GPT-4o-mini** — AI summarization
- **JavaScript** — data parsing and transformation
- **Markdown / HTML** — output formatting

---

## 📋 How to Use

1. Open the n8n workflow
2. Click **"Execute Workflow"**
3. Type your research topic in the **Edit Fields** node (e.g. `CRISPR cancer therapy`, `Alzheimer's early detection`, `COVID-19 long term effects`)
4. Wait a few seconds
5. Read your AI-generated summary with full citations

---

## 💡 Real-World Impact

Access to medical knowledge shouldn't require a PhD. MedSumAI democratizes access to scientific research by:

- Reducing the time to understand a new medical topic from **hours to seconds**
- Making PubMed's 35+ million articles accessible to **non-experts**
- Helping students and researchers **stay current** with the latest findings
- Providing **verified, cited sources** — not just generic AI responses

---

## 📁 Project Structure

```
MedSumAI/
├── README.md               # This file
├── workflow/
│   └── MedSumAI.json       # n8n workflow export
└── screenshots/
    └── workflow.png        # Workflow diagram
```

---

## 🔧 Setup & Installation

### Prerequisites
- [n8n](https://n8n.io/) (self-hosted or cloud)
- OpenAI API key
- No PubMed API key needed (free public access)

### Steps
1. Clone this repository
   ```bash
   git clone https://github.com/YOUR_USERNAME/MedSumAI.git
   ```
2. Import `workflow/MedSumAI.json` into your n8n instance
3. Add your OpenAI API key in the **"Message a Model"** node credentials
4. Click **Execute Workflow** and start researching!

---

## 🔄 Workflow

![MedSumAI Workflow](workflow.png)

## 🙋 About

Built by a high school student passionate about making science more accessible. MedSumAI started as a personal project to quickly research biomedical topics for school, and grew into a fully automated research assistant.

GitHub: [@mitrapatel1909](https://github.com/mitrapatel1909)

---

## 📄 License

MIT License — free to use, modify, and share.

---

*Powered by the [PubMed E-utilities API](https://www.ncbi.nlm.nih.gov/home/develop/api/) and [OpenAI](https://openai.com/)*
