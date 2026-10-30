import TasksApp from './DailyTasks.jsx';
import SnippetsApp from './DailySnippets.jsx';
import LanguageApp from './DailyLanguage.jsx';
import TravelApp from './DailyTravel.jsx';
import MealsApp from './DailyMeals.jsx';

const components = { tasks: TasksApp, snippets: SnippetsApp, language: LanguageApp, travel: TravelApp, meals: MealsApp };
export default function DailyApps(props) {
  const Component = components[props.appId];
  return Component ? <Component {...props} /> : null;
}
