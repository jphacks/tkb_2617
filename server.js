import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import { Agent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

fs.mkdirSync('cache', { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/pdfjs', express.static('node_modules/pdfjs-dist/build'));

const BASE = process.env.LLM_BASE_URL;
const KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL;
const MODEL_FAST = process.env.LLM_MODEL_FAST || MODEL; // 手順の解析だけ軽いモデルにしたいとき用（任意）

const LAYOUT_PROMPT = `あなたは家具の組み立て説明書を解析するアシスタントです。
添付画像は説明書PDFの最初の数ページ（1枚目が1ページ目）です。次を読み取り、JSONだけを出力してください（説明文やコードブロックは不要）。

1. title: 家具の名前。
2. assemblyStartPage: 番号付きの組み立て手順（1番の手順）が最初に載っているページ番号（1始まり）。表紙・安全上の注意・部品一覧・道具の図のページは含めない。
3. parts: 説明書に載っている部品の一覧。

部品ごとの項目:
- id: 説明書の部品記号（A,B,C…や①②…）。name: 日本語の部品名。qty: 個数。
- kind: "board"（板・箱）、"rod"（丸棒・角材・脚などの細長い部材）、"screw"（ネジ・ボルト・ダボなどの小さな留め具）のどれか。
- dims: 寸法(mm)の配列。説明書に寸法があれば必ずその数値を使う。board は [厚み, 幅, 長さ]、rod と screw は [直径, 直径, 長さ]。書いていなければ完成図の比率から、現実的な大きさで推定する。

向きと位置のルール（座標の数字は書かない）:
- 軸は x=左右、y=上下、z=前後。家具を正しい向きで床に置いた完成状態で考える。
- long_axis: その部品の一番長い辺が向く軸（"x" か "y" か "z"）。
- thin_axis: board だけ。厚みが向く軸。天板のように水平な板は "y"、立てた側板は "x" か "z"。
- anchor: 本体の中心になる、いちばん大きな部品に1つだけ true を付ける（その部品に placements は不要）。
- placements: screw 以外の部品に、qty と同じ数だけ書く。1個ごとに次を指定する。
  - on: くっつく相手の部品のid
  - at: 相手のどの面にくっつくか。"top"(上) "bottom"(下) "left"(左) "right"(右) "front"(前) "back"(後)
  - align: くっつく面に沿った2軸について、"min"（その軸のマイナス側の端にそろえる）、"max"（プラス側の端にそろえる）、"center"（中央）を指定する。at が top/bottom のときは x と z、left/right のときは y と z、front/back のときは x と y を書く。
  - inset: 端から内側へずらす量(mm)。省略可。
- 左右や前後に2個ある部品は、1個目と2個目で at を逆（left と right など）にする。
- 脚は rod で long_axis は "y"。机なら、天板の下面（at:"bottom"）の四隅に付ける。align の x と z を min/max にして、inset で少し内側へ寄せる。

出力例（小さな棚）:
{
  "title": "ミニ棚",
  "assemblyStartPage": 3,
  "parts": [
    {"id":"B","name":"底板","kind":"board","qty":1,"dims":[18,300,382],"long_axis":"x","thin_axis":"y","anchor":true},
    {"id":"A","name":"側板","kind":"board","qty":2,"dims":[18,300,800],"long_axis":"y","thin_axis":"x","placements":[
      {"on":"B","at":"left","align":{"y":"min","z":"center"}},
      {"on":"B","at":"right","align":{"y":"min","z":"center"}}]},
    {"id":"C","name":"天板","kind":"board","qty":1,"dims":[18,300,418],"long_axis":"x","thin_axis":"y","placements":[
      {"on":"A","at":"top","align":{"x":"min","z":"center"}}]},
    {"id":"E","name":"ネジ M4x30","kind":"screw","qty":8,"dims":[4,4,30]}
  ]
}`;

function stepsPrompt(partsInfo, pageStart, pageEnd) {
  return `あなたは家具の組み立て説明書を解析するアシスタントです。
添付画像は説明書PDFの${pageStart}〜${pageEnd}ページ目です（最初の画像が${pageStart}ページ目）。
この画像にある「番号付きの組み立て手順」だけを、JSONだけで出力してください（説明文やコードブロックは不要）。
表紙・安全上の注意・部品一覧・道具の紹介だけのページは手順ではないので、{"steps":[]} を返してください。

部品の一覧（id・名前・種類・個数・寸法）:
${JSON.stringify(partsInfo)}

ルール:
- 手順番号ごとに1つの step にする。1ページに複数の手順があれば、すべて別の step にする。
- page は、その手順が載っているPDFのページ番号（${pageStart}〜${pageEnd}）。
- text は日本語1〜2文。「どの部品を、どこに、どう取り付けるか」を、使う材料の記号・名前・寸法つきで書く（例: 側板A(800×300×18mm)を2枚、向かい合わせに立てます）。ネジなら種類と本数も書く。
- uses には、その手順で使う部品を {"id":部品のid,"qty":その手順で使う個数} で入れる。id は上の部品一覧にあるものだけを使う。
- ネジ・ボルトなど kind が screw の部品を使う手順では、into にそのネジを打ち込む相手の部品のid（板など）を入れる。

出力例:
{
  "steps": [
    {"page":${pageStart},"text":"側板A(800×300×18mm)を2枚、向かい合わせに立てます。","uses":[{"id":"A","qty":2}]},
    {"page":${pageStart},"text":"底板Bを側板の間に差し込み、ネジDを4本で固定します。","uses":[{"id":"B","qty":1},{"id":"D","qty":4}],"into":"A"}
  ]
}`;
}

async function askLLM(images, prompt, model, maxTokens) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j.error || j));
    const text = j.choices[0].message.content;
    try {
      return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    } catch {
      console.warn('JSONの解析に失敗。再試行します');
    }
  }
  throw new Error('モデルの出力がJSONになりませんでした');
}

app.post('/api/analyze', async (req, res) => {
  try {
    const { mode, images = [], parts = [], pageStart = 1, pageEnd = 1 } = req.body;
    const isLayout = mode === 'layout';
    const prompt = isLayout ? LAYOUT_PROMPT : stepsPrompt(parts, pageStart, pageEnd);
    const model = isLayout ? MODEL : MODEL_FAST;

    const hash = crypto.createHash('sha256').update(images.join('') + prompt + model).digest('hex').slice(0, 16);
    const cachePath = `cache/${hash}.json`;
    if (fs.existsSync(cachePath)) {
      return res.json(JSON.parse(fs.readFileSync(cachePath, 'utf-8')));
    }

    const json = await askLLM(images, prompt, model, isLayout ? 5000 : 1800);
    fs.writeFileSync(cachePath, JSON.stringify(json));
    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => console.log('http://localhost:3000 を開いてください'));