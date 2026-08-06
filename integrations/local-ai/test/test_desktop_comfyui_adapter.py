import unittest

from desktop_comfyui_adapter import render_workflow, select_output_image


class DesktopComfyUiAdapterTest(unittest.TestCase):
    def test_workflow_placeholders_preserve_numeric_types(self):
        workflow = {
            "1": {
                "inputs": {
                    "text": "{{PROMPT}}",
                    "width": "{{WIDTH}}",
                    "label": "size={{WIDTH}}",
                }
            }
        }
        rendered = render_workflow(workflow, {"{{PROMPT}}": "红色方块", "{{WIDTH}}": 1024})
        self.assertEqual(rendered["1"]["inputs"]["text"], "红色方块")
        self.assertEqual(rendered["1"]["inputs"]["width"], 1024)
        self.assertEqual(rendered["1"]["inputs"]["label"], "size=1024")

    def test_last_comfyui_output_image_is_selected(self):
        history = {
            "prompt-1": {
                "outputs": {
                    "9": {"images": [{"filename": "preview.png"}]},
                    "12": {"images": [{"filename": "final.png", "type": "output"}]},
                }
            }
        }
        self.assertEqual(select_output_image(history, "prompt-1")["filename"], "final.png")

    def test_missing_output_is_not_reported_as_success(self):
        with self.assertRaisesRegex(RuntimeError, "no output image"):
            select_output_image({"prompt-1": {"outputs": {}}}, "prompt-1")


if __name__ == "__main__":
    unittest.main()
