"""Generate both downloadable itineraries from index.html. Requires reportlab.

Run after itinerary edits. NYC_PDF_FONT can specify a Unicode TrueType font.
"""
from pathlib import Path
from html.parser import HTMLParser
from html import escape
import os, re, ast
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

ROOT = Path(__file__).resolve().parents[1]

class Node:
    def __init__(self, tag='', attrs=None):
        self.tag, self.attrs, self.children = tag, dict(attrs or []), []
    def all(self, tag=None, cls=None):
        result=[]
        for child in self.children:
            if isinstance(child, Node):
                if (not tag or child.tag==tag) and (not cls or cls in child.attrs.get('class','').split()):
                    result.append(child)
                result.extend(child.all(tag, cls))
        return result
    def text(self, lang):
        other='fr' if lang=='zh' else 'zh'
        if 'data-'+other in self.attrs: return ''
        if 'data-'+lang in self.attrs: return self.attrs['data-'+lang]
        return ' '.join(c.text(lang) if isinstance(c,Node) else c for c in self.children)

class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root=Node(); self.stack=[self.root]
    def handle_starttag(self, tag, attrs):
        node=Node(tag,attrs); self.stack[-1].children.append(node)
        if tag=='br': node.children.append(' / ')
        if tag not in ('meta','link','img','br','hr','input','source','wbr'): self.stack.append(node)
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i].tag==tag:
                self.stack=self.stack[:i]; break
    def handle_data(self,data): self.stack[-1].children.append(data)

source=(ROOT/'index.html').read_text(encoding='utf-8')
parser=Parser(); parser.feed(source)
font=os.environ.get('NYC_PDF_FONT','C:/Windows/Fonts/msyh.ttc')
pdfmetrics.registerFont(TTFont('Itinerary',font))
style=ParagraphStyle('Body',fontName='Itinerary',fontSize=8.2,leading=12,spaceAfter=3,wordWrap='CJK',textColor=colors.HexColor('#253247'))
small=ParagraphStyle('Small',parent=style,fontSize=7.3,leading=10.5,textColor=colors.HexColor('#526074'))
heading=ParagraphStyle('Heading',parent=style,fontSize=17,leading=23,spaceAfter=8)
sub=ParagraphStyle('Sub',parent=style,fontSize=10,leading=15,spaceAfter=8)

def clean(text):
    text=text.replace('<br>',' / ')
    text=re.sub('[\U00010000-\U0010ffff\ufe0f\u2600-\u26ff]','',text)
    return re.sub(r'\s+',' ',text).strip().replace('–','-').replace('—','-').replace('↗','').replace('→',' > ')
def p(text,st=style): return Paragraph(escape(clean(text)),st)
out=ROOT/'output'/'pdf'; out.mkdir(parents=True,exist_ok=True)
for lang in ('zh','fr'):
    story=[]
    for day in range(1,7):
        section=next(n for n in parser.root.all('section') if n.attrs.get('id')==f'day-{day}')
        if day>1: story.append(PageBreak())
        title=section.all('h2')[0].text(lang)
        if lang=='fr':
            match=re.search(r"'svgt-d"+str(day)+r"':\{fr:(.*?),zh:",source)
            title=ast.literal_eval(match.group(1))
        date=section.all(cls='day-date')[0].text(lang)
        weather=section.all(cls='day-weather')[0].text(lang)
        story.extend([p(f'DAY {day}   |   {date}',sub),p(title,heading),p(('天气：' if lang=='zh' else 'Météo : ')+weather+' °C',small)])
        story.append(p(section.all(cls='route-line')[0].text(lang),small))
        if day==1:
            story.append(p('◎ 朋友推荐 · 高优先级：9月23日19:00百老汇。天气更新于2026年9月16日。' if lang=='zh' else '◎ Recommandations de votre ami. Priorité haute : Broadway le 23/09 à 19h. Météo au 16/09/2026.',small))
        story.append(Spacer(1,8))
        for brief in section.all(cls='brief-card'):
            strong=brief.all('strong')
            if strong:
                text=brief.text(lang)
                # Keep planning notes, without repeating the small category labels.
                title_text=strong[0].text(lang)
                at=text.find(title_text)
                story.append(p(text[at:] if at>=0 else text,small))
        story.append(Spacer(1,8))
        labels=['时间','地点与行程','实用信息'] if lang=='zh' else ['Horaire','Lieu et programme','Infos pratiques']
        data=[[p(t,small) for t in labels]]
        priority=[]
        for tr in section.all('tr'):
            cells=tr.all('td')
            if len(cells)!=8: continue
            time=cells[1].all('strong')[0].text(lang)
            place=cells[2].text(lang)
            detail=cells[3].text(lang)
            facts=[cells[i].text(lang) for i in (4,5,6)]
            right=[p(' / '.join(facts),small)]
            links=cells[7].all('a')
            if links:
                url=links[0].attrs.get('href','')
                right.append(Paragraph('<link href="'+escape(url,quote=True)+'" color="#2463a1">'+('官网 / 详情' if lang=='zh' else 'Site / détails')+'</link>',small))
            data.append([p(time,small),[p(place),p(detail,small)],right])
            if 'priority-row' in tr.attrs.get('class',''): priority.append(len(data)-1)
        table=Table(data,colWidths=[66,260,185],repeatRows=1,hAlign='LEFT')
        commands=[('VALIGN',(0,0),(-1,-1),'TOP'),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#eef2f6')),('LINEBELOW',(0,0),(-1,0),.7,colors.HexColor('#cad3df')),('LINEBELOW',(0,1),(-1,-1),.35,colors.HexColor('#e0e5ec')),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]
        for i in priority: commands.append(('BACKGROUND',(0,i),(-1,i),colors.HexColor('#fff0ce')))
        table.setStyle(TableStyle(commands));story.append(table)
        for note in section.all('details'):
            story.append(Spacer(1,10));story.append(p(note.text(lang),small))
    def footer(canvas,doc):
        canvas.setFont('Itinerary',7)
        canvas.setFillColor(colors.HexColor('#64748b'))
        canvas.drawString(42,25,'David & Echo | New York | 19-24.09.2026')
        canvas.drawRightString(A4[0]-42,25,str(doc.page))
        canvas.linkURL('https://echozhangsz-ui.github.io/new-york-initiary/',(42,20,300,35))
    dest=out/f'new-york-itinerary-{lang}.pdf'
    doc=SimpleDocTemplate(str(dest),pagesize=A4,leftMargin=42,rightMargin=42,topMargin=35,bottomMargin=43,title='New York - David & Echo',author='David & Echo')
    doc.build(story,onFirstPage=footer,onLaterPages=footer)
    print(dest)
