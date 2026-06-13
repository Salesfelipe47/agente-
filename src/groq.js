const Groq = require('groq-sdk');
const SYSTEM_PROMPT = require('./prompt');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function getAIResponse(history) {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
    ],
    max_tokens: 250,   // força respostas curtas e diretas
    temperature: 0.85, // mais criativo e natural, menos robótico
    top_p: 0.9,
  });

  return completion.choices[0]?.message?.content?.trim() || '';
}

module.exports = { getAIResponse };
