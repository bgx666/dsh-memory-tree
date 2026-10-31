
**输出 JSON 的形状（键名与嵌套层级必须一致；数组是数组、对象是对象）**：
{"summary": "叙述文本", "narration": "一两句人话的概述", "task": {"goal": "", "status": "", "todo": [], "next_steps": [], "blockers": []}, "decisions": [{"what": "", "why": ""}], "lessons": {"errors": [{"symptom": "", "cause": "", "fix": ""}], "patterns": []}, "context": {"env": [], "commands": [], "artifacts": [], "constraints": []}, "user": []}
（没有内容的字段按前文规则省略或留空；cwd 由系统填写，不用输出。）
