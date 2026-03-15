# MedSum-AI
Automated biomedical research assistant powered by PubMed + GPT-4o-mini 

MedSumAI is an automated research tool that takes any medical or biomedical topic, searches PubMed (the world's largest database of scientific articles), and generates a clear, easy-to-understand summary — complete with citations and direct links to the original articles.

This tool was built to help:

Students researching topics for science classes or competitions
Researchers who need a fast overview of a new topic
Patients and caregivers trying to understand a diagnosis or treatment
Anyone curious about the latest in medical science

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
