export const maxDuration = 60;

import React from 'react';
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { Octokit } from '@octokit/rest';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dbConnect from '@/lib/mongoose';
import { Chat } from '@/models/Chat';
import { prisma } from '@/lib/prisma';
import { ImageResponse } from 'next/og';

const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
const ORG = 'UniExamPrep';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = ((session.user as any).githubUsername ?? session.user.email ?? 'anonymous') as string;

  const { repo, subjectPath, subjectName, selectedFiles, noteType } = await req.json();
  if (!repo || !subjectPath || !selectedFiles?.length) {
    return NextResponse.json({ error: 'Missing params' }, { status: 400 });
  }

  let apiKey = process.env.GEMINI_API_KEY!;
  let isPublic = true;
  let customModel = 'gemini-3.1-flash-lite';

  if (session.user.email) {
    const dbUser = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { geminiApiKey: true, geminiModel: true },
    });
    if (dbUser?.geminiApiKey) {
      apiKey = dbUser.geminiApiKey;
      isPublic = false;
      if (dbUser.geminiModel) customModel = dbUser.geminiModel;
    }
  }

  const customGenai = new GoogleGenerativeAI(apiKey);
  const pdfParts: { inlineData: { data: string; mimeType: string } }[] = [];
  for (const file of selectedFiles.slice(0, 5)) {
    try {
      const { data: blob } = await octokit.git.getBlob({
        owner: ORG, repo: file.repo || repo, file_sha: file.sha,
      });
      pdfParts.push({
        inlineData: { data: blob.content.replace(/\n/g, ''), mimeType: 'application/pdf' },
      });
    } catch { /* skip */ }
  }

  if (pdfParts.length === 0) {
    return NextResponse.json({ error: 'Could not read any PDF files' }, { status: 400 });
  }

  const model = customGenai.getGenerativeModel({ model: customModel });
  
  // ==========================================
  // IMAGE GENERATION (1-PAGER)
  // ==========================================
  if (noteType === '1-pager') {
    const prompt = `Analyze the provided study materials for "${subjectName}".
Unit ka one pager bana do Hinglish (Hindi + English) mein. I need a dense, high-yield Cheat Sheet covering the syllabus.

You MUST output ONLY a raw valid JSON object.
Format:
{
  "title": "UNIT 1: CATCHY TITLE",
  "subtitle": "ONE PAGE REVISION",
  "boxes": [
    { 
      "title": "1. TOPIC NAME", 
      "content": "Dense bullet points or key formulas. Keep it very concise and high-yield.",
      "color": "pink"
    }
  ]
}
Rules:
1. Since the user provides the FULL syllabus, you must output exactly 15 to 21 boxes (so it forms a massive 3-column grid filling the entire page).
2. Organize the boxes UNIT-WISE (e.g. "Unit 1: Intereference", "Unit 2: Diffraction").
3. For "color", randomly select one of: "pink", "yellow", "blue", "green", "purple", "orange". Distribute colors evenly.`;

    let generatedText = '';
    let cheatSheetData = null;
    try {
      const result = await model.generateContent([prompt, ...pdfParts]);
      generatedText = result.response.text().trim();
    } catch (e: any) {
      if (e.message?.includes('503') || e.message?.includes('Service Unavailable')) {
        try {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const result = await model.generateContent([prompt, ...pdfParts]);
          generatedText = result.response.text().trim();
        } catch (e2: any) {
          return NextResponse.json({ error: `AI Image JSON generation failed (503 on retry): ${e2.message}` }, { status: 500 });
        }
      } else {
        return NextResponse.json({ error: `AI Image JSON generation failed: ${e.message}` }, { status: 500 });
      }
    }

    try {
      const firstBrace = generatedText.indexOf('{');
      const lastBrace = generatedText.lastIndexOf('}');
      const jsonStr = generatedText.slice(firstBrace, lastBrace + 1);
      cheatSheetData = JSON.parse(jsonStr);
    } catch (e: any) {
      return NextResponse.json({ error: `Failed to parse AI JSON response: ${e.message}` }, { status: 500 });
    }

    const colorMap: any = {
      pink: { bg: '#fdf2f8', border: '#fbcfe8', titleBg: '#f9a8d4', text: '#831843' },
      yellow: { bg: '#fefce8', border: '#fef08a', titleBg: '#fde047', text: '#713f12' },
      blue: { bg: '#eff6ff', border: '#bfdbfe', titleBg: '#93c5fd', text: '#1e3a8a' },
      green: { bg: '#f0fdf4', border: '#bbf7d0', titleBg: '#86efac', text: '#14532d' },
      purple: { bg: '#faf5ff', border: '#e9d5ff', titleBg: '#d8b4fe', text: '#581c87' },
      orange: { bg: '#fff7ed', border: '#fed7aa', titleBg: '#fdba74', text: '#7c2d12' },
    };

    // Render the React Component for the Image!
    try {
      const imageResp = new ImageResponse(
        (
          <div style={{ display: 'flex', flexDirection: 'column', backgroundColor: '#f8fafc', width: '100%', height: '100%', padding: '40px', fontFamily: 'sans-serif' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '6px solid #1e293b', paddingBottom: '20px', marginBottom: '30px' }}>
              <div style={{ display: 'flex', fontSize: '50px', fontWeight: '900', color: '#0f172a', textTransform: 'uppercase' }}>
                {cheatSheetData.title || subjectName}
              </div>
              <div style={{ display: 'flex', fontSize: '32px', fontWeight: 'bold', backgroundColor: '#ef4444', color: 'white', padding: '12px 24px', borderRadius: '30px' }}>
                {cheatSheetData.subtitle || 'ONE PAGE REVISION'}
              </div>
            </div>
            
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', justifyContent: 'flex-start' }}>
              {(cheatSheetData.boxes || []).map((box: any, idx: number) => {
                const theme = colorMap[box.color] || colorMap.blue;
                return (
                  <div key={idx} style={{ display: 'flex', flexDirection: 'column', width: '31.5%', backgroundColor: theme.bg, border: `3px solid ${theme.border}`, borderRadius: '12px', overflow: 'hidden', marginBottom: '10px' }}>
                    <div style={{ display: 'flex', backgroundColor: theme.titleBg, padding: '12px 16px', fontSize: '26px', fontWeight: 'bold', color: theme.text }}>
                      {box.title}
                    </div>
                    <div style={{ display: 'flex', padding: '16px', fontSize: '22px', color: '#334155', lineHeight: 1.5 }}>
                      {box.content}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ),
        { width: 1600, height: 2000 }
      );

      const arrayBuffer = await imageResp.arrayBuffer();
      const base64Image = Buffer.from(arrayBuffer).toString('base64');
      const fileName = '1-Pager_CheatSheet.png';
      const parts = subjectPath.split('/').filter(Boolean);
      const innerPath = parts.slice(2).join('/');
      const filePath = `${innerPath}/Notes/${fileName}`;

      let fileSha = undefined;
      try {
        const { data: fileData } = await octokit.repos.getContent({ owner: ORG, repo, path: filePath });
        if (!Array.isArray(fileData)) fileSha = fileData.sha;
      } catch (e) { /* file doesn't exist */ }

      await octokit.repos.createOrUpdateFileContents({
        owner: ORG,
        repo,
        path: filePath,
        message: `DocsKeeper AI: Generated beautiful 1-Pager PNG`,
        content: base64Image,
        sha: fileSha,
      });

      // Save a dummy chat so the frontend UI doesn't crash
      let chatId;
      try {
        await dbConnect();
        const chat = await Chat.create({
          userId, subjectPath, title: `1-Pager: ${subjectName}`,
          messages: [{ role: 'assistant', content: `![1-Pager Infographic](https://raw.githubusercontent.com/${ORG}/${repo}/main/${encodeURI(filePath)})` }],
          isPublic,
        });
        chatId = chat._id;
      } catch (e) {}

      return NextResponse.json({
        success: true,
        chatId: chatId,
        content: `Your visual 1-Pager Infographic was successfully generated and uploaded to GitHub as ${fileName}!`,
      });
    } catch (e: any) {
      return NextResponse.json({ error: `Image rendering/upload failed: ${e.message}` }, { status: 500 });
    }
  }

  // ==========================================
  // STANDARD MARKDOWN TEXT GENERATION
  // ==========================================
  const prompt = `You are a university exam study assistant. Analyze the provided documents (Syllabus, PYQs, and Notes) for the subject "${subjectName}" and generate comprehensive pre-processed study notes covering EVERY topic found in the syllabus and materials.
CRITICAL INSTRUCTIONS:
- You MUST aggressively reorganize and order the content based on IMPORTANCE.
- Mark highly important topics clearly using visually distinct icons.
- Format your response in beautiful Markdown with clear headings.
- Use proper LaTeX math formatting for all equations (e.g., $I_E = \\frac{V_E}{R_E}$) because the UI fully supports KaTeX rendering. Use $$ for block equations and $ for inline equations.
Include Subject Overview, Comprehensive Topic Breakdown, Likely Exam Questions, and Study Tips.`;

  let generatedText: string;
  try {
    const result = await model.generateContent([prompt, ...pdfParts]);
    generatedText = result.response.text().trim();
  } catch (e: any) {
    if (e.message?.includes('429') && e.message?.toLowerCase().includes('quota')) {
      return NextResponse.json({ error: 'Daily API Quota Limit Exceeded. Try tomorrow.' }, { status: 402 });
    }
    if (e.message?.includes('503') || e.message?.includes('Service Unavailable')) {
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const result = await model.generateContent([prompt, ...pdfParts]);
        generatedText = result.response.text().trim();
      } catch (e2: any) {
        return NextResponse.json({ error: `AI generation failed (503 on retry): ${e2.message}` }, { status: 500 });
      }
    } else {
      return NextResponse.json({ error: `AI generation failed: ${e.message}` }, { status: 500 });
    }
  }

  await dbConnect();
  let chatId;
  try {
    const chat = await Chat.create({
      userId, subjectPath, title: `Study Notes: ${subjectName}`,
      messages: [{ role: 'assistant', content: generatedText }],
      isPublic,
    });
    chatId = chat._id;
  } catch (e: any) {
    return NextResponse.json({ error: `Failed to save to database: ${e.message}` }, { status: 500 });
  }

  try {
    const fileName = 'Comprehensive_Notes.md';
    const parts = subjectPath.split('/').filter(Boolean);
    const innerPath = parts.slice(2).join('/');
    const filePath = `${innerPath}/Notes/${fileName}`;
    const fileContent = Buffer.from(generatedText).toString('base64');
    let fileSha = undefined;
    try {
      const { data: fileData } = await octokit.repos.getContent({ owner: ORG, repo, path: filePath });
      if (!Array.isArray(fileData)) fileSha = fileData.sha;
    } catch (e) {}

    await octokit.repos.createOrUpdateFileContents({
      owner: ORG, repo, path: filePath,
      message: `DocsKeeper AI: Generated ${fileName}`,
      content: fileContent,
      sha: fileSha,
    });
  } catch (e: any) {}

  return NextResponse.json({ success: true, chatId, content: generatedText });
}
