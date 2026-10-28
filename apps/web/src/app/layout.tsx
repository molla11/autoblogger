import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'풀이의 기록 · Autoblogger',description:'문제를 풀던 순간부터, 근거가 있는 한 편의 글까지.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ko"><body>{children}</body></html>}
