🧬 MedSumAI
AI-powered biomedical research summarizer — making scientific literature accessible to everyone.

What is MedSumAI?
MedSumAI is an automated research tool that takes any medical or biomedical topic, searches PubMed (the world's largest database of scientific articles), and generates a clear, easy-to-understand summary — complete with citations and direct links to the original articles.
No medical degree required. Just type a topic and get answers.

Why I Built This
Every year, millions of scientific articles are published on PubMed. But most people — students, patients, caregivers, and even researchers outside a specific field — can't easily access or understand them. The language is technical, the search process is tedious, and making sense of multiple papers at once is time-consuming.
MedSumAI solves this. It bridges the gap between cutting-edge medical research and the people who need it most, by automatically finding relevant articles and translating them into plain language.
This tool was built to help:

Students researching topics for science classes or competitions
Researchers who need a fast overview of a new topic
Patients and caregivers trying to understand a diagnosis or treatment
Anyone curious about the latest in medical science


How It Works
MedSumAI is built as an automated workflow using n8n, a powerful open-source automation platform. Here's the step-by-step flow:
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
Workflow Nodes
StepToolPurpose1Edit FieldsUser inputs their research topic2HTTP RequestSearch PubMed for matching article IDs3HTTP RequestFetch article details from PubMed4HTTP RequestFetch full article data (abstracts, metadata)5XML to JSONParse PubMed's XML response6Code (JavaScript)Extract title, authors, abstract, PMID & build links7GPT-4o-miniGenerate a plain-language summary with references8Markdown to HTMLFormat the final output
