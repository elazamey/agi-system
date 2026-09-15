from pydantic import BaseModel
from typing import List


class FilePatch(BaseModel):
    file_path: str
    content: str
    action: str = "write"


def parse_code_submission(
    code: str,
    target_file: str = "index.html",
) -> List[FilePatch]:
    return [
        FilePatch(
            file_path=target_file,
            content=code,
            action="write",
        )
    ]
